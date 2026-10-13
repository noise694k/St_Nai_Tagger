/**
 * NAI Tag Extractor - SillyTavern 코어 접근 레이어
 * 모든 ST 내부 모듈 접근을 이 파일에 격리한다.
 * 원칙: 전부 "읽기"만. ST 상태를 변경하는 코드는 이 확장 어디에도 없어야 한다.
 */

let _script = null;      // /script.js
let _extensions = null;  // /scripts/extensions.js
let _secrets = null;     // /scripts/secrets.js
let _openai = null;      // /scripts/openai.js
let _tokenizers = null;  // /scripts/tokenizers.js
let _popup = null;       // /scripts/popup.js

export const ST = {
    ready: false,
    missing: [],
};

/** ST 모듈 동적 로드 (개별 실패 허용 — 실패한 기능만 저하) */
export async function initST() {
    const tryImport = async (label, path) => {
        try {
            return await import(/* webpackIgnore: true */ path);
        } catch (e) {
            ST.missing.push(`${label}: ${e.message}`);
            return null;
        }
    };

    // 경로 기준: scripts/extensions/third-party/st-nai-tagger/src/
    _script     = await tryImport('script.js',     '../../../../../script.js');
    _extensions = await tryImport('extensions.js', '../../../../extensions.js');
    _secrets    = await tryImport('secrets.js',    '../../../../secrets.js');
    _openai     = await tryImport('openai.js',     '../../../../openai.js');
    _tokenizers = await tryImport('tokenizers.js', '../../../../tokenizers.js');
    _popup      = await tryImport('popup.js',      '../../../../popup.js');

    ST.ready = !!(_script && _extensions);
    return ST.ready;
}

/** ST 매크로 치환 ({{char}}, {{description}}, {{persona}} 등). 미확보 시 원문 유지(fail-open) */
export function macro(text) {
    try {
        if (typeof _script?.substituteParams === 'function') {
            return _script.substituteParams(text);
        }
    } catch (e) { /* fail-open */ }
    return text;
}

/** ST 요청 헤더 (CSRF 포함) */
export function requestHeaders() {
    try {
        if (typeof _script?.getRequestHeaders === 'function') {
            return _script.getRequestHeaders();
        }
    } catch (e) { /* ignore */ }
    const h = {};
    const meta = document.querySelector('meta[name="csrf-token"]');
    if (meta) h['X-CSRF-Token'] = meta.getAttribute('content');
    return h;
}

/** ST 컨텍스트 (chat, characters, name1/name2 등) */
export function stContext() {
    try {
        if (typeof _extensions?.getContext === 'function') return _extensions.getContext();
    } catch (e) { /* ignore */ }
    return null;
}

/** secret 존재 여부 확인 (키 값 자체는 다루지 않음 — secret_state는 boolean 맵) */
export function hasSecret(providerKey) {
    try {
        const S = _secrets?.SECRET_KEYS;
        const state = _secrets?.secret_state;
        if (!S || !state) return false;
        const map = {
            openai: [S.OPENAI],
            claude: [S.CLAUDE],
            google: [S.MAKERSUITE],
            vertexai: [S.VERTEXAI, S.VERTEXAI_SERVICE_ACCOUNT],
            openrouter: [S.OPENROUTER],
            deepseek: [S.DEEPSEEK],
            zai: [S.ZAI],
        };
        return (map[providerKey] || []).some(k => k && state[k]);
    } catch (e) {
        return false;
    }
}

/** Vertex AI 인증 관련 설정 읽기 (oai_settings 읽기 전용) */
export function vertexInfo() {
    try {
        const o = _openai?.oai_settings;
        if (!o) return {};
        return {
            auth_mode: o.vertexai_auth_mode || 'express',
            region: o.vertexai_region || 'global',
            express_project_id: o.vertexai_express_project_id || '',
        };
    } catch (e) {
        return {};
    }
}

/** Z.AI 엔드포인트 종류 ('common' | 'coding') — ST 연결 설정 읽기 전용 */
export function zaiEndpoint() {
    try {
        return _openai?.oai_settings?.zai_endpoint || 'common';
    } catch (e) {
        return 'common';
    }
}

/** 토큰 수 계산. 실패 시 근사치(chars/4)와 approx 플래그 반환 */
export async function countTokens(text) {
    try {
        if (typeof _tokenizers?.getTokenCountAsync === 'function') {
            const n = await _tokenizers.getTokenCountAsync(text);
            if (Number.isFinite(n)) return { count: n, approx: false };
        }
    } catch (e) { /* fallthrough */ }
    return { count: Math.ceil((text || '').length / 4), approx: true };
}

/** 확인 팝업. ST popup 미확보 시 window.confirm 폴백 */
export async function confirmPopup(html, title = '확인') {
    try {
        if (_popup?.callGenericPopup && _popup?.POPUP_TYPE) {
            const r = await _popup.callGenericPopup(html, _popup.POPUP_TYPE.CONFIRM, title);
            return r === _popup.POPUP_RESULT?.AFFIRMATIVE || r === 1 || r === true;
        }
    } catch (e) { /* fallthrough */ }
    return window.confirm(html.replace(/<[^>]+>/g, ' '));
}

/** 토스트 알림 */
export function toast(msg, type = 'info') {
    try {
        if (window.toastr && typeof window.toastr[type] === 'function') {
            window.toastr[type](msg, 'NAI Tag Extractor');
            return;
        }
    } catch (e) { /* ignore */ }
    console.log(`[NAI Tag Extractor] ${type}: ${msg}`);
}
