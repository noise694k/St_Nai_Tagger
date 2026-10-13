/**
 * NAI Tag Extractor - LLM 호출
 * ST의 /api/backends/chat-completions/generate 를 직접 fetch.
 * 유저의 현재 프리셋/연결 설정을 전혀 사용하지도, 변경하지도 않는다.
 * (chat_completion_source 를 요청 본문에서 직접 지정 — llm-translator 계열과 동일한 접근 방식)
 */

import { requestHeaders, hasSecret, vertexInfo, zaiEndpoint } from './stcore.js';

const SOURCE_MAP = {
    openai: 'openai',
    claude: 'claude',
    google: 'makersuite',
    vertexai: 'vertexai',
    openrouter: 'openrouter',
    deepseek: 'deepseek',
    zai: 'zai',
};

const isGemini = p => p === 'google' || p === 'vertexai';

/** 프리필 비호환 가능성이 있는 실패 → 호출측이 프리필 없이 1회 재시도할 수 있게 표시 */
function prefillSuspectError(message, settings) {
    const e = new Error(message);
    e.retryWithoutPrefill = !!settings.prefill_enabled && isGemini(settings.provider);
    return e;
}

/** 프로바이더별 응답에서 텍스트 추출 */
function extractText(data, provider) {
    let r = null;
    switch (provider) {
        case 'openai':
        case 'openrouter':
        case 'deepseek':
        case 'zai':
            r = data?.choices?.[0]?.message?.content;
            break;
        case 'claude':
            r = data?.content?.[0]?.text ?? data?.choices?.[0]?.message?.content;
            break;
        case 'google':
        case 'vertexai':
            r = firstString([
                data?.candidates?.[0]?.content?.parts?.[0]?.text,
                data?.candidates?.[0]?.content,
                data?.choices?.[0]?.message?.content,
                data?.text,
            ]);
            break;
        default:
            r = data?.choices?.[0]?.message?.content;
    }
    return typeof r === 'string' ? r.trim() : '';
}

function firstString(arr) {
    for (const v of arr) if (typeof v === 'string' && v.trim()) return v;
    return null;
}

/** 응답에서 토큰 사용량 추출 (OpenAI계 usage / Anthropic usage / Google usageMetadata) */
function extractUsage(data) {
    const u = data?.usage;
    if (u && (u.prompt_tokens != null || u.input_tokens != null)) {
        return {
            input: u.prompt_tokens ?? u.input_tokens ?? null,
            output: u.completion_tokens ?? u.output_tokens ?? null,
            thoughts: u.completion_tokens_details?.reasoning_tokens ?? null,
        };
    }
    const g = data?.usageMetadata;
    if (g && g.promptTokenCount != null) {
        return {
            input: g.promptTokenCount ?? null,
            output: g.candidatesTokenCount ?? null,
            thoughts: g.thoughtsTokenCount ?? null,
        };
    }
    return null;
}

/** 현재 설정 기준 모델명 결정 */
export function resolveModel(settings) {
    const p = settings.provider;
    if (settings.use_custom_model?.[p]) {
        return (settings.custom_models?.[p] || '').trim();
    }
    return settings.models?.[p] || '';
}

/**
 * LLM 단일 호출
 * @param {Object} settings - 확장 설정
 * @param {string} prompt   - 전송 전문
 * @returns {Promise<{text: string, ms: number}>}
 */
export async function callLLM(settings, prompt) {
    const provider = settings.provider;
    const source = SOURCE_MAP[provider];
    if (!source) throw new Error(`지원하지 않는 프로바이더: ${provider}`);

    const model = resolveModel(settings);
    if (!model) throw new Error('모델이 선택되지 않았습니다. 연결 설정을 확인해주세요.');

    if (!settings.use_reverse_proxy && !hasSecret(provider)) {
        throw new Error(`${provider.toUpperCase()} API 키가 ST에 등록되어 있지 않습니다. (리버스프록시 사용 시 프록시 옵션을 켜주세요)`);
    }

    const messages = [{ role: 'user', content: prompt }];
    if (settings.prefill_enabled && (settings.prefill_content || '').trim()) {
        const role = isGemini(provider) ? 'model' : 'assistant';
        messages.push({ role, content: settings.prefill_content.trim() });
    }

    const body = {
        model,
        messages,
        temperature: Number(settings.temperature) || 0,
        stream: false,
        chat_completion_source: source,
    };
    const maxTokens = Number(settings.max_tokens);
    if (maxTokens > 0) body.max_tokens = maxTokens;

    if (provider === 'vertexai') {
        const v = vertexInfo();
        body.vertexai_auth_mode = v.auth_mode || 'express';
        body.vertexai_region = v.region || 'global';
        if (body.vertexai_auth_mode === 'express' && v.express_project_id) {
            body.vertexai_express_project_id = v.express_project_id;
        }
    }

    if (provider === 'zai') {
        // ST의 Z.AI 연결 설정(일반/코딩 플랜 엔드포인트)을 읽기만 해서 따름
        body.zai_endpoint = zaiEndpoint();
    }

    if (settings.use_reverse_proxy) {
        body.reverse_proxy = (settings.reverse_proxy_url || '').trim();
        body.proxy_password = settings.reverse_proxy_password || '';
        if (!body.reverse_proxy) throw new Error('리버스프록시 URL이 비어 있습니다.');
    }

    const t0 = Date.now();
    let response;
    try {
        response = await fetch('/api/backends/chat-completions/generate', {
            method: 'POST',
            headers: { ...requestHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    } catch (e) {
        throw new Error(`네트워크 요청 실패: ${e.message}`);
    }

    if (!response.ok) {
        let msg = `HTTP ${response.status}`;
        try {
            const err = await response.json();
            msg = err?.error?.message || err?.message || response.statusText || msg;
        } catch (e) { msg = response.statusText || msg; }
        const friendly = {
            401: 'API 키가 잘못되었거나 권한이 없습니다.',
            403: 'API 접근이 거부되었습니다.',
            429: '호출 한도 초과입니다. 잠시 후 다시 시도해주세요.',
        }[response.status];
        const text = friendly ? `${friendly} (${msg})` : msg;
        // 400(잘못된 요청)은 Gemini 최신 모델의 프리필 거부일 수 있음
        if (response.status === 400) throw prefillSuspectError(text, settings);
        throw new Error(text);
    }

    const data = await response.json();
    const text = extractText(data, provider);
    const usage = extractUsage(data);
    if (!text) {
        const finish = data?.candidates?.[0]?.finishReason || data?.choices?.[0]?.finish_reason || '';
        const thoughts = data?.usageMetadata?.thoughtsTokenCount;
        const prefillHint = (settings.prefill_enabled && isGemini(provider))
            ? ' Gemini 최신 모델은 프리필(말미 model 메시지)을 지원하지 않을 수 있습니다.'
            : '';
        if (String(finish).toUpperCase().includes('MAX_TOKEN') || String(finish) === 'length') {
            const extra = Number.isFinite(thoughts) ? ` (사고 토큰 ${thoughts} 소모됨 — thinking 모델은 사고가 출력 예산을 먼저 씁니다)` : '';
            throw new Error(`출력 토큰 한도에 걸려 본문이 비었습니다${extra}. 연결 설정에서 Max Tokens를 늘려주세요.`);
        }
        if (finish) throw prefillSuspectError(`응답이 비어 있습니다 (finishReason: ${finish}).${prefillHint} 모델/안전필터/프록시 설정을 확인해주세요.`, settings);
        throw prefillSuspectError(`응답이 비어 있습니다.${prefillHint} 모델/프록시 설정을 확인해주세요.`, settings);
    }
    return { text, ms: Date.now() - t0, usage };
}
