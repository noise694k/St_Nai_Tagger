/**
 * NAI Tag Extractor - 출력 후처리 (순수 모듈, ST 비의존, node 테스트 가능)
 * 목표: LLM 응답에서 "태그 한 줄"만 남기고, 메타발언/서사/코드펜스를 제거한다.
 * 제거된 내용은 removed 배열로 반환해 전송 로그에서 확인 가능하게 한다 (과잉 삭제 검증용).
 */

/** 흔한 메타 접두 패턴 (영/한) */
const META_LINE = /^\s*(here (are|is)\b|sure[,!.]|okay[,!.]|of course|certainly|below (are|is)\b|the (following|extracted) tags|tags\s*:|output\s*:|result\s*:|다음은|추출된 태그|태그\s*[:：]|결과\s*[:：]|알겠습니다|물론입니다)/i;

/** 문장형(서사/메타) 라인 휴리스틱: 콤마 밀도가 낮고 문장부호로 끝나는 긴 줄 */
function looksLikeSentence(line) {
    const t = line.trim();
    if (t.length < 40) return false;
    const commas = (t.match(/,/g) || []).length;
    const words = t.split(/\s+/).length;
    // 태그 줄은 콤마 밀도가 높다. 단어 8개당 콤마 1개 미만이고 문장부호로 끝나면 문장으로 판단.
    const lowCommaDensity = commas < Math.floor(words / 8);
    const sentenceEnd = /[.!?。！？]["']?\s*$/.test(t);
    return lowCommaDensity && sentenceEnd;
}

/**
 * LLM 응답 정리
 * @param {string} raw
 * @returns {{ tags: string, removed: string[] }}
 */
export function cleanLLMOutput(raw) {
    const removed = [];
    if (!raw || typeof raw !== 'string') return { tags: '', removed };

    let text = raw.trim();

    // 1) 코드펜스 제거 (내용은 보존)
    text = text.replace(/```[a-zA-Z]*\n?([\s\S]*?)```/g, (_, inner) => inner);
    text = text.replace(/```/g, '');

    // 2) 줄 단위 필터
    const kept = [];
    for (const line of text.split(/\r?\n/)) {
        const t = line.trim();
        if (!t) continue;
        if (META_LINE.test(t)) { removed.push(t); continue; }
        if (looksLikeSentence(t)) { removed.push(t); continue; }
        kept.push(t);
    }

    // 3) 병합 후 토큰 단위 정리
    let joined = kept.join(', ');
    // 양끝 따옴표 제거
    joined = joined.replace(/^["'`]+|["'`]+$/g, '');
    // 불릿/번호 제거
    joined = joined.replace(/(^|,\s*)[-*•]\s+/g, '$1').replace(/(^|,\s*)\d+[.)]\s+/g, '$1');

    // 4) 콤마 분해 → 공백 정규화 → 중복 제거 (가중치 포함 원형 유지)
    const seen = new Set();
    const tags = [];
    for (let part of joined.split(',')) {
        part = part.trim().replace(/\s+/g, ' ');
        if (!part) continue;
        const key = part.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        tags.push(part);
    }

    return { tags: tags.join(', '), removed };
}

/**
 * 태그에서 NAI/SD 계열 가중치 문법을 분리해 "조회용 순수 태그"를 얻는다.
 * 지원: 1.2::tag:: , {tag}, [tag], (tag:1.2), tag:1.2
 * @param {string} tag
 * @returns {{ core: string, hadWeight: boolean }}
 */
export function stripWeight(tag) {
    let t = (tag || '').trim();
    let had = false;
    let changed = true;
    while (changed && t.length) {
        changed = false;
        const before = t;
        t = t.replace(/^-?\d+(?:\.\d+)?\s*::\s*([\s\S]*?)\s*::$/,'$1');        // 1.2::tag::
        t = t.replace(/^::\s*([\s\S]*?)\s*::$/, '$1');                          // ::tag::
        t = t.replace(/^\{+\s*([\s\S]*?)\s*\}+$/, '$1');                        // {tag}
        t = t.replace(/^\[+\s*([\s\S]*?)\s*\]+$/, '$1');                        // [tag]
        t = t.replace(/^\(+\s*([\s\S]*?)\s*(?::\s*-?\d+(?:\.\d+)?)?\s*\)+$/, '$1'); // (tag:1.2)
        t = t.replace(/^([\s\S]*?)\s*:\s*-?\d+(?:\.\d+)?$/, '$1');              // tag:1.2
        if (t !== before) { had = true; changed = true; t = t.trim(); }
    }
    return { core: t, hadWeight: had };
}

/** 단부루 조회용 정규화: 소문자, 공백→언더스코어 */
export function normalizeForDanbooru(coreTag) {
    return (coreTag || '').trim().toLowerCase().replace(/\s+/g, '_');
}

/** 결과 문자열 → 태그 배열 (가중치 원형 유지) */
export function splitTags(tagLine) {
    return (tagLine || '').split(',').map(s => s.trim()).filter(Boolean);
}
