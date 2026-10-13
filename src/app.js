/**
 * NAI Tag Extractor - 상태 관리 + 추출 파이프라인
 */

import { DEFAULT_SETTINGS, KEYS, PROMPT_DEFAULTS, PROVIDERS, promptOf, normalizePromptValue } from './defaults.js';
import { kvGet, kvSet, kvRemove, kvClearAll } from './store.js';
import { macro, stContext, countTokens } from './stcore.js';
import { callLLM, resolveModel } from './llm.js';
import { cleanLLMOutput, splitTags } from './postproc.js';
import { createDanbooruClient, runDanbooruLookup } from './danbooru.js';
import { buildPass1, buildPass2, formatRecentMessages } from './promptbuild.js';
import { loadCurrentCharacterWI, entriesToText, entryKey, currentCharKey } from './worldinfo.js';
import { selectSceneMessages } from './chatrange.js';
import { mergeImport, parseLibraryImport } from './library.js';

export const app = {
    settings: structuredClone(DEFAULT_SETTINGS),
    wiEntries: [],          // 마지막으로 불러온 WI 엔트리 목록
    wiSelected: new Set(),  // entryKey 집합
    sendLog: [],            // 세션 로그 (최근 30개 영속)
    lastRun: null,          // { pass1Prompt, pass2Prompt, result, danbooru }
    running: false,
    library: [],            // 저장된 프롬프트 (IndexedDB: KEYS.library)
};

const LOG_LIMIT = 30;

// ===== 설정 로드/저장 =====

/**
 * 저장된(또는 가져온) 설정을 현재 스키마로 정규화. 로드·가져오기 공용.
 * 프롬프트: 과거/현재 기본값과 "정확히" 같을 때만 null(기본값 사용)로 바꾸고, 수정본은 그대로 보존.
 */
export function normalizeSettings(saved) {
    const src = (saved && typeof saved === 'object') ? saved : {};
    const s = { ...structuredClone(DEFAULT_SETTINGS), ...src };
    for (const k of ['models', 'custom_models', 'use_custom_model']) {
        s[k] = { ...((src[k] && typeof src[k] === 'object') ? src[k] : {}) };
    }
    const from = src.schema ?? 1;
    // v1→v2: 구 기본값(1024)을 그대로 쓰던 경우만 4096으로 상향 (thinking 모델 대응)
    if (from < 2 && src.max_tokens === 1024) s.max_tokens = 4096;
    // v2→v3: vertex region 설정 제거 (ST 설정을 따름)
    delete s.vertexai_region;
    // 프롬프트 기본값 판정 (매 로드마다 실행해도 결과가 같음)
    for (const key of Object.keys(PROMPT_DEFAULTS)) s[key] = normalizePromptValue(key, s[key]);
    // v6: 삭제된 프로바이더(cohere 등)를 쓰던 경우 기본값으로
    if (!PROVIDERS.includes(s.provider)) s.provider = DEFAULT_SETTINGS.provider;
    // v5: 장면 메시지 선택 방식
    if (!['recent', 'range'].includes(s.scene_select_mode)) s.scene_select_mode = 'recent';
    s.scene_range_start = String(s.scene_range_start ?? '');
    s.scene_range_end = String(s.scene_range_end ?? '');
    s.schema = DEFAULT_SETTINGS.schema;
    return s;
}

export async function loadAll() {
    const saved = await kvGet(KEYS.settings, null);
    if (saved && typeof saved === 'object') {
        // v2→v3: 오염 가능성이 있던 구 단부루 캐시 폐기
        if ((saved.schema ?? 1) < 3) kvRemove('danbooru_cache');
        app.settings = normalizeSettings(saved);
        if ((saved.schema ?? 1) < DEFAULT_SETTINGS.schema) kvSet(KEYS.settings, app.settings);
    }
    app.sendLog = await kvGet(KEYS.sendLog, []);
    await loadLibrary();
}

let saveTimer = null;
export function saveSettings() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { kvSet(KEYS.settings, app.settings); }, 400);
}

// ===== 전송 로그 =====

function addLog(entry) {
    app.sendLog.unshift({ ts: new Date().toISOString(), ...entry });
    if (app.sendLog.length > LOG_LIMIT) app.sendLog.length = LOG_LIMIT;
    kvSet(KEYS.sendLog, app.sendLog);
}

// ===== 히스토리 =====

export async function getHistory() {
    return await kvGet(KEYS.history, []);
}

export async function pushHistory(item) {
    const limit = Math.max(0, Number(app.settings.history_limit) || 0);
    if (limit === 0) return;
    const list = await kvGet(KEYS.history, []);
    list.unshift(item);
    if (list.length > limit) list.length = limit;
    await kvSet(KEYS.history, list);
}

export async function deleteHistoryAt(index) {
    const list = await kvGet(KEYS.history, []);
    list.splice(index, 1);
    await kvSet(KEYS.history, list);
    return list;
}

// ===== 프롬프트 저장소 =====

export async function loadLibrary() {
    const raw = await kvGet(KEYS.library, []);
    // 저장은 검증된 항목만 하므로 여기선 형태만 방어 (항목을 버리지 않음)
    app.library = (Array.isArray(raw) ? raw : [])
        .filter(x => x && typeof x === 'object' && typeof x.content === 'string')
        .map(x => ({
            ...x,
            title: String(x.title ?? ''),
            memo: String(x.memo ?? ''),
            updatedAt: Number(x.updatedAt) || 0,
        }));
}

/** 저장 실패 시 예외 (호출측이 유저에게 알림) — 메모리 상태는 저장 성공 후에만 교체 */
export async function saveLibrary(list) {
    const ok = await kvSet(KEYS.library, list);
    if (!ok) throw new Error('브라우저 저장소(IndexedDB)에 쓰지 못했습니다. 저장 공간을 확인해주세요.');
    app.library = list;
}

// ===== 전체 백업 / 전체 삭제 =====

export async function buildFullBackup() {
    return {
        ext: 'st-nai-tagger', version: 2, exported: new Date().toISOString(),
        settings: app.settings,
        history: await getHistory(),
        library: app.library,
    };
}

/** 전체 백업 적용: 설정·히스토리는 교체, 저장된 프롬프트는 병합(기존 항목 유지) */
export async function applyFullBackup(data) {
    if (data?.ext !== 'st-nai-tagger' || !data.settings) throw new Error('이 확장의 백업 파일이 아닙니다.');
    const settings = normalizeSettings(data.settings);
    if (!(await kvSet(KEYS.settings, settings))) throw new Error('설정 저장 실패');
    app.settings = settings;
    if (Array.isArray(data.history)) await kvSet(KEYS.history, data.history);
    let lib = null;
    if (Array.isArray(data.library)) {
        const m = mergeImport(app.library, parseLibraryImport(data));
        await saveLibrary(m.list);
        lib = m;
    }
    return { lib };
}

export async function wipeAll() {
    await kvClearAll();
    app.settings = structuredClone(DEFAULT_SETTINGS);
    app.sendLog = [];
    app.wiEntries = [];
    app.wiSelected = new Set();
    app.lastRun = null;
    app.library = [];
}

// ===== WI 선택 영속화 =====

export async function loadWIForCurrentChar() {
    const { charName, entries } = await loadCurrentCharacterWI();
    app.wiEntries = entries;
    app.wiSelected = new Set();
    const allSel = await kvGet(KEYS.wiSelection, {});
    const key = currentCharKey();
    const savedSel = key ? (allSel[key] || []) : [];
    const validKeys = new Set(entries.map(entryKey));
    for (const k of savedSel) if (validKeys.has(k)) app.wiSelected.add(k);
    return { charName, entries };
}

export async function saveWISelection() {
    const key = currentCharKey();
    if (!key) return;
    const allSel = await kvGet(KEYS.wiSelection, {});
    allSel[key] = [...app.wiSelected];
    await kvSet(KEYS.wiSelection, allSel);
}

// ===== 소스 블록 구성 =====

function buildSources() {
    const s = app.settings;
    const sources = { charProfile: '', userPersona: '', worldInfo: '' };

    if (s.src_char_profile) {
        const desc = macro('{{description}}');
        const pers = macro('{{personality}}');
        const parts = [];
        if (desc && desc !== '{{description}}') parts.push(desc);
        if (pers && pers !== '{{personality}}') parts.push(`(Personality) ${pers}`);
        sources.charProfile = parts.join('\n\n');
    }
    if (s.src_user_persona) {
        const p = macro('{{persona}}');
        if (p && p !== '{{persona}}') sources.userPersona = p;
    }
    if (s.src_worldinfo && app.wiSelected.size) {
        const selected = app.wiEntries.filter(e => app.wiSelected.has(entryKey(e)));
        sources.worldInfo = entriesToText(selected);
    }
    return sources;
}

/** 현재 설정 기준 장면용 메시지 선택 (최근 N개 / 번호 범위). 읽기 전용 */
export function getSceneSelection() {
    const s = app.settings;
    const chat = stContext()?.chat || [];
    return selectSceneMessages(chat, {
        mode: s.scene_select_mode,
        count: s.scene_msg_count,
        start: s.scene_range_start,
        end: s.scene_range_end,
    });
}

function currentCharName() {
    const ctx = stContext();
    return ctx?.name2 || '';
}

// ===== Raw Prompt 미리보기 =====

export async function buildPreview() {
    const s = app.settings;
    let sceneText = '';
    if (s.scene_mode) {
        const sel = getSceneSelection();
        if (!sel.ok) throw new Error(`장면 메시지 선택 오류: ${sel.error}`);
        sceneText = formatRecentMessages(sel.msgs);
    }
    const prompt = buildPass1({
        basePrompt: macro(promptOf(s, 'base_prompt')),
        targetName: macro(s.target_name),
        currentCharName: currentCharName(),
        detailInstructions: macro(s.detail_instructions),
        sources: buildSources(),
        sceneMode: s.scene_mode,
        scenePrompt: macro(promptOf(s, 'scene_prompt')),
        sceneFocus: macro(s.scene_focus),
        recentMessages: sceneText,
        danbooruEnabled: s.danbooru_enabled,
    });
    const tok = await countTokens(prompt);
    return { prompt, tokens: tok.count, approx: tok.approx };
}

// ===== 단부루 연결 테스트 (모바일 진단용) =====

export async function testDanbooru() {
    const client = createDanbooruClient({ fetchFn: (...a) => fetch(...a), cache: {} });
    try {
        const r = await client.verifyTags(['long_hair']);
        const v = r['long_hair'];
        if (v && !v.miss) return { ok: true, msg: `연결 성공 — long_hair (${v.post_count} posts) 확인됨` };
        return { ok: false, msg: '응답은 왔지만 예상 데이터가 아닙니다. (사이트 정책 변경 가능성)' };
    } catch (e) {
        return { ok: false, msg: `연결 실패: ${e.message} — CORS/네트워크 차단 가능성. 단부루 옵션 없이도 추출은 정상 동작합니다.` };
    }
}

// ===== 메인 파이프라인 =====

/** 실측 usage 부재 시(예: ST 서버가 Vertex usageMetadata를 벗겨서 전달) 토크나이저 추정치 생성 */
async function ensureUsage(r, prompt) {
    if (r.usage && (r.usage.input != null || r.usage.output != null)) return r.usage;
    try {
        const [i, o] = await Promise.all([countTokens(prompt), countTokens(r.text)]);
        return { input: i.count, output: o.count, thoughts: null, approx: true };
    } catch (e) {
        return null;
    }
}

/** LLM 호출 + 빈 응답 시 프리필 없이 1회 자동 재시도 (google/vertexai 한정) */
async function callWithPrefillFallback(s, prompt, stage, model) {
    try {
        const r = await callLLM(s, prompt);
        addLog({ stage, provider: s.provider, model, chars: prompt.length, ok: true, ms: r.ms, usage: await ensureUsage(r, prompt) });
        return r;
    } catch (e) {
        addLog({ stage, provider: s.provider, model, chars: prompt.length, ok: false, error: e.message });
        // Gemini 최신 모델 + 프리필 비호환 대응 (빈 응답 또는 400): 프리필 없이 1회 재시도
        if (!e.retryWithoutPrefill) throw e;
        const s2 = { ...s, prefill_enabled: false };
        try {
            const r2 = await callLLM(s2, prompt);
            addLog({ stage: `${stage} (프리필 없이 재시도)`, provider: s.provider, model, chars: prompt.length, ok: true, ms: r2.ms, usage: await ensureUsage(r2, prompt) });
            return r2;
        } catch (e2) {
            addLog({ stage: `${stage} (프리필 없이 재시도)`, provider: s.provider, model, ok: false, error: e2.message });
            throw e2;
        }
    }
}

/**
 * @param {Function} onStatus - (문구) => void
 * @returns {Promise<{tags: string, danbooru: Object|null, degraded: string}>}
 */
export async function runExtraction(onStatus = () => {}) {
    if (app.running) throw new Error('이미 추출이 진행 중입니다.');
    app.running = true;
    const s = app.settings;
    const model = resolveModel(s);

    try {
        // --- 1차 호출 ---
        onStatus('프롬프트 조립 중...');
        const preview = await buildPreview();
        const pass1Prompt = preview.prompt;

        onStatus(`1차 추출 요청 중... (${s.provider}/${model})`);
        const r1 = await callWithPrefillFallback(s, pass1Prompt, '1차 추출', model);

        const c1 = cleanLLMOutput(r1.text);
        if (!c1.tags) throw new Error('1차 응답에서 태그를 찾지 못했습니다. (전송 로그의 필터 내역 확인)');
        if (c1.removed.length) {
            addLog({ stage: '1차 후처리', ok: true, filtered: c1.removed });
        }

        let finalTags = c1.tags;
        let danbooru = null;
        let degraded = '';
        let pass2Prompt = '';

        // --- 단부루 보정 (옵션) ---
        if (s.danbooru_enabled) {
            onStatus('단부루 태그 조회 중...');
            const cache = await kvGet(KEYS.danbooruCache, {});
            const client = createDanbooruClient({ fetchFn: (...a) => fetch(...a), cache, onProgress: onStatus });
            const lookup = await runDanbooruLookup(client, splitTags(c1.tags), s.danbooru_related);
            await kvSet(KEYS.danbooruCache, client.getCache());
            addLog({
                stage: '단부루 조회', ok: !lookup.degraded || !!lookup.report,
                verified: lookup.summary.verified.length,
                notFound: lookup.summary.notFound.length,
                error: lookup.degradeReason || undefined,
                danbooruDetail: {
                    verified: lookup.summary.verified.slice(0, 40),
                    notFound: lookup.summary.notFound.slice(0, 40),
                    aliased: lookup.summary.aliased.slice(0, 20),
                },
            });

            if (lookup.report) {
                danbooru = lookup.summary;
                if (lookup.degraded) degraded = `단부루 조회 일부 실패(${lookup.degradeReason}) — 확보된 정보로 보정 진행`;

                // --- 2차 호출 ---
                pass2Prompt = buildPass2({
                    refinePrompt: macro(promptOf(s, 'refine_prompt')),
                    candidateTags: c1.tags,
                    danbooruReport: lookup.report,
                    targetName: macro(s.target_name) || currentCharName(),
                    detailInstructions: macro(s.detail_instructions),
                    sceneMode: s.scene_mode,
                    sceneFocus: macro(s.scene_focus),
                });
                onStatus(`2차 보정 요청 중... (${s.provider}/${model})`);
                try {
                    const r2 = await callWithPrefillFallback(s, pass2Prompt, '2차 보정', model);
                    const c2 = cleanLLMOutput(r2.text);
                    if (c2.removed.length) addLog({ stage: '2차 후처리', ok: true, filtered: c2.removed });
                    if (c2.tags) {
                        finalTags = c2.tags;
                    } else {
                        degraded = '2차 응답에서 태그를 찾지 못해 1차 결과를 사용합니다.';
                    }
                } catch (e) {
                    degraded = `2차 보정 실패(${e.message}) — 1차 결과를 사용합니다.`;
                }
            } else {
                degraded = `단부루 조회 실패(${lookup.degradeReason}) — 1차 결과를 그대로 사용합니다.`;
            }
        }

        app.lastRun = { pass1Prompt, pass2Prompt, result: finalTags, danbooru };

        // 히스토리 저장
        await pushHistory({
            ts: new Date().toISOString(),
            target: (s.target_name || '').trim() || currentCharName(),
            scene: !!s.scene_mode,
            danbooru: !!s.danbooru_enabled,
            tags: finalTags,
        });

        return { tags: finalTags, danbooru, degraded };
    } finally {
        app.running = false;
    }
}
