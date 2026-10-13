/**
 * NAI Tag Extractor - 기본값 정의 (순수 모듈, ST 비의존)
 */

export const EXT_ID = 'st-nai-tagger';

/** 기본 추출 프롬프트 — 유저 수정 가능, 초기화 버튼으로 복원 */
export const DEFAULT_BASE_PROMPT = `You are a tag extraction engine for NovelAI (Danbooru-style) image generation.

TASK: From the reference materials provided below, extract image generation tags describing the PHYSICAL APPEARANCE of the TARGET CHARACTER only.

TAG ORDER:
1. Count tag: 1girl, 1boy, or 1other.
2. Only if the target is clearly a character from an existing anime/game/novel: the identifier tag "character name (series name)". If unsure, skip it.
3. Age and body type, skin, hair (length, style, color), eyes, face, species features (animal ears, horns, tail, wings).
4. Outfit and accessories.

STRICT RULES:
- Extract appearance only.
- Do NOT output tags about scene, background, location, actions, poses, camera, or emotions, UNLESS (a) a [SCENE EXTRACTION] section is present below, or (b) the [ADDITIONAL USER INSTRUCTIONS] explicitly ask for a specific scene, mood, background, or pose — in that case, output tags for exactly what the user asked for, in addition to the appearance tags.
- If the materials mention multiple characters, use ONLY information about the target character. Ignore everyone else.
- Use short, real Danbooru-style English tags. No sentences, no metaphors, no invented phrases.
- Never write story character names as tags; the image model does not know them (the identifier tag in step 2 is the only exception).
- Body vs. clothing: real horns, animal ears, tails, wings, hair and eye color are body features, not accessories. A horned headband or a cat-ear hairband is an accessory.
- Do not add quality tags (masterpiece, best quality...), artist tags, or negative tags.
- [ADDITIONAL USER INSTRUCTIONS], when present, have the HIGHEST priority: if they conflict with any rule above, follow the user instructions.
- NO meta commentary, NO explanations, NO greetings, NO story continuation, NO roleplay. This is not a chat.
- Output format: a single line of comma-separated tags. Nothing else.`;

/** 장면 추출 프롬프트 — 장면 모드 켜면 프롬프트에 추가됨 */
export const DEFAULT_SCENE_PROMPT = `[SCENE EXTRACTION]
In ADDITION to the appearance tags above, extract tags for the CURRENT SCENE from the chat messages provided. Each message starts with its number (#N).

SCENE TAG ORDER (same single line, after the appearance tags):
1. People: if other people are visible, put their count tags (1boy, 1girl...) right after the target's count tag at the start of the line; if the target is alone, add solo. Refer to other people as "another" (e.g. hand on another's shoulder), never by name.
2. The target right now: clothing (if the scene's clothing differs from the profile, use the scene's clothing instead of the profile outfit), pose, action written with body part and object (holding teacup, arms around another's neck), expression (stack 2-3, e.g. flustered, blush, wide-eyed), gaze (looking at viewer, looking at another, looking away...). Always include an expression and a gaze; infer them if the text does not state them.
3. Place: as specific as possible (classroom, cafe interior, rainy street rather than just indoors/outdoors), plus visible props.
4. Camera: one shot size (close-up, upper body, cowboy shot, full body) and one angle (from above, from below, from side...). If the action involves legs or sitting/kneeling/lying, do not use close-up or upper body. With close-up or upper body, do not add tags for shoes, legs, or skirt length.
5. Lighting and mood (soft lighting, sunset, moonlight, dramatic lighting, warm colors...). You may infer these.

RULES:
- What appears in the image must come from the messages: do not invent people, events, props, or weather (no rain unless it rains in the text).
- If a [SCENE FOCUS] is given, it is the user's own description of the scene they want, written in natural language (any language). Extract that scene and ignore other scenes in the messages. Details the user describes there may be used even if the messages do not mention them. Tags are always written in English.
- If the messages contain multiple scenes and no focus is given, use the most recent one.`;

/** 단부루 보정(2차 호출) 프롬프트 */
export const DEFAULT_REFINE_PROMPT = `You are refining image generation tags for NovelAI using Danbooru lookup results.

You are given: (1) CANDIDATE TAGS extracted from a character/scene, (2) DANBOORU LOOKUP RESULTS showing which candidates are real Danbooru tags, alias corrections, similar tags, and related tags.

RULES:
- Prefer exact verified Danbooru tags. If a candidate has an alias correction, use the corrected (consequent) name.
- If a candidate is NOT a real Danbooru tag but a similar verified tag fits the same meaning, replace it with the verified tag.
- If no suitable Danbooru tag exists for a concept, KEEP it as a natural-language tag (NovelAI understands natural language).
- You MAY add tags from the related-tag lists when they genuinely fit the character/scene. Do not add tags that contradict the candidates.
- Do not invent characters, copyrights, or artist tags that were not in the candidates.
- The candidate tags may already carry emphasis weights (e.g. 1.2::tag::) chosen with full story context. PRESERVE them: when you replace a candidate with a corrected or verified tag, carry its weight over to the new tag. Do not remove or change existing weights. Only tags you newly add may get a weight, sparingly.
- Keep the candidates' order. Place any added tag next to the tags it relates to.
- NO meta commentary. Output format: a single line of comma-separated tags. Nothing else.`;

/** 1차 호출에 항상 덧붙는 가중치 규칙 (원본 컨텍스트를 보는 1차가 가중치를 정함) */
export const WEIGHT_RULE = `
- Emphasis weights (NovelAI syntax): write 1.2::tag:: (range 1.1 to 1.4) to strengthen the 1-3 most important traits, or 0.8::tag:: (range 0.6 to 0.9) to weaken. Weight one short tag at a time, never a phrase or a group of tags. At most 3 weighted tags.`;

/** 단부루 ON일 때 1차 호출에 추가로 붙는 안내 */
export const DANBOORU_HINT = `
- Prefer Danbooru-style underscore_tags where you know them; otherwise natural language is fine.`;

/** 기본 프리필 (assistant/model 역할로 대화 말미에 주입 — 메타발언 억제용) */
export const DEFAULT_PREFILL = 'Understood. Outputting only the single line of comma-separated tags, with no commentary:';

// ===== 편집 가능한 프롬프트: null = "기본값 사용" =====
// 기본값을 그대로 쓰는 유저는 확장 업데이트 시 새 기본값을 자동으로 받고,
// 수정본을 쓰는 유저의 프롬프트는 절대 덮어쓰지 않는다.

export const PROMPT_DEFAULTS = {
    base_prompt: DEFAULT_BASE_PROMPT,
    scene_prompt: DEFAULT_SCENE_PROMPT,
    refine_prompt: DEFAULT_REFINE_PROMPT,
};

/** 텍스트 지문: 정규화(CRLF→LF, 앞뒤 공백 제거) 후 길이 + FNV-1a 32bit */
export function fingerprint(text) {
    const t = String(text ?? '').replace(/\r\n?/g, '\n').trim();
    let h = 0x811c9dc5;
    for (let i = 0; i < t.length; i++) {
        h ^= t.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return `${t.length}:${h.toString(16).padStart(8, '0')}`;
}

/** 과거 버전 기본 프롬프트의 지문 (v1.0~v1.2, v1.3, v1.4). 이 값과 정확히 일치할 때만 "수정 안 함"으로 판정 */
const LEGACY_PROMPT_FINGERPRINTS = {
    base_prompt: ['817:41781521', '1170:a2c3a8b6', '1905:f88e561d'],
    scene_prompt: ['522:728f5bce', '1846:65be82ff'],
    refine_prompt: ['1141:200fcaa2', '1290:e22c5197', '1372:cc315564'],
};

/** 현재 적용될 프롬프트 텍스트 */
export function promptOf(settings, key) {
    const v = settings?.[key];
    return (typeof v === 'string') ? v : PROMPT_DEFAULTS[key];
}

/** 저장값이 기본값(현재/과거)과 정확히 같으면 null(기본값 사용)로 정규화. 그 외는 그대로 보존 */
export function normalizePromptValue(key, value) {
    if (typeof value !== 'string' || !value.trim()) return null; // 비우면 기본값 사용
    const fp = fingerprint(value);
    if (fp === fingerprint(PROMPT_DEFAULTS[key])) return null;
    if ((LEGACY_PROMPT_FINGERPRINTS[key] || []).includes(fp)) return null;
    return value;
}

export const PROVIDERS = ['openai', 'claude', 'google', 'vertexai', 'openrouter', 'deepseek', 'zai'];

const GEMINI_MODELS = [
    'gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite',
    'gemini-3.1-pro-preview', 'gemini-3.1-flash-lite', 'gemini-2.5-pro', 'gemini-2.5-flash',
];

export const MODEL_LISTS = {
    openai: ['gpt-5.6', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4'],
    claude: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
    google: GEMINI_MODELS,
    vertexai: GEMINI_MODELS,
    openrouter: ['google/gemini-3.5-flash'],
    deepseek: ['deepseek-v4-pro', 'deepseek-v4-flash'],
    zai: ['glm-5.2', 'glm-5-turbo', 'glm-5.1', 'glm-5', 'glm-4.7', 'glm-4.7-flash', 'glm-4.6'],
};

/** 설정 기본값 (전부 IndexedDB 저장 대상) */
export const DEFAULT_SETTINGS = {
    schema: 6,
    // 연결
    provider: 'google',
    models: {},              // provider -> 선택 모델
    custom_models: {},       // provider -> 직접 입력 모델명
    use_custom_model: {},    // provider -> boolean
    use_reverse_proxy: false,
    reverse_proxy_url: '',
    reverse_proxy_password: '',
    max_tokens: 4096,
    prefill_enabled: false,
    prefill_content: DEFAULT_PREFILL,
    temperature: 0.3,
    // 프롬프트 (null = 기본값 사용)
    base_prompt: null,
    scene_prompt: null,
    refine_prompt: null,
    detail_instructions: '',   // 상세 지시사항
    target_name: '',           // 대상 캐릭터 이름
    // 인풋 소스
    src_char_profile: true,
    src_user_persona: false,
    src_worldinfo: false,
    // 장면 모드
    scene_mode: false,
    scene_select_mode: 'recent', // 'recent' | 'range'
    scene_msg_count: 4,
    scene_range_start: '',       // 메시지 번호(#) — 빈 값 허용
    scene_range_end: '',         // 빈 값 = 마지막 메시지까지
    scene_focus: '',
    // 단부루
    danbooru_enabled: false,
    danbooru_related: true,
    // 히스토리
    history_limit: 10,
};

export const KEYS = {
    settings: 'settings',
    history: 'history',
    danbooruCache: 'danbooru_cache_v2',
    wiSelection: 'wi_selection',   // { [charKey]: string[] (entryKey 배열) }
    sendLog: 'send_log',
    library: 'prompt_library',     // 저장된 프롬프트 배열
};
