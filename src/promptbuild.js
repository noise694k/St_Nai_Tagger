/**
 * NAI Tag Extractor - 프롬프트 조립 (순수 모듈, ST 비의존)
 * 입력 블록들을 받아 1차/2차 프롬프트 전문을 만든다. 매크로 치환은 호출측(stcore.macro) 책임.
 */

import { WEIGHT_RULE, DANBOORU_HINT } from './defaults.js';

function block(title, body) {
    const b = (body || '').trim();
    if (!b) return '';
    return `\n\n=== ${title} ===\n${b}`;
}

/**
 * 1차(추출) 프롬프트 조립
 * @param {Object} p
 * @param {string} p.basePrompt        - 기본 추출 프롬프트 (매크로 치환 완료본)
 * @param {string} p.targetName        - 대상 캐릭터 이름 (빈 값이면 currentCharName 사용)
 * @param {string} p.currentCharName
 * @param {string} p.detailInstructions
 * @param {Object} p.sources           - { charProfile, userPersona, worldInfo } (각각 문자열, 없으면 '')
 * @param {boolean} p.sceneMode
 * @param {string} p.scenePrompt       - 장면 추출 프롬프트 (치환 완료본)
 * @param {string} p.sceneFocus
 * @param {string} p.recentMessages    - 포맷된 장면용 메시지 텍스트
 * @param {boolean} p.danbooruEnabled  - true면 단부루식 태그 표기 선호 안내 추가
 * @returns {string}
 */
export function buildPass1(p) {
    const target = (p.targetName || '').trim() || (p.currentCharName || '').trim() || '(the main character)';

    let out = (p.basePrompt || '').trim();
    out += WEIGHT_RULE;
    if (p.danbooruEnabled) out += DANBOORU_HINT;

    out += `\n\nTARGET CHARACTER: ${target}`;

    out += block('REFERENCE: CHARACTER PROFILE', p.sources?.charProfile);
    out += block('REFERENCE: USER PERSONA', p.sources?.userPersona);
    out += block('REFERENCE: WORLD INFO (selected entries)', p.sources?.worldInfo);

    // D: 유저 상세 지시 — 자료 직후, 장면 섹션보다 앞 (최우선 지시로 참조됨)
    if ((p.detailInstructions || '').trim()) {
        out += block('ADDITIONAL USER INSTRUCTIONS', p.detailInstructions);
    }

    if (p.sceneMode) {
        // B → 최근 메시지 → E (장면 구체 지시를 출력 직전에 배치)
        out += '\n\n' + (p.scenePrompt || '').trim();
        out += block('CHAT MESSAGES', p.recentMessages);
        if ((p.sceneFocus || '').trim()) {
            out += block("SCENE FOCUS (user's description of the wanted scene)", p.sceneFocus);
        }
    }

    out += '\n\nNow output the tags. Remember: one single line, comma-separated tags only.';
    return out;
}

/**
 * 2차(단부루 보정) 프롬프트 조립
 * @param {Object} p
 * @param {string} p.refinePrompt   - 보정 프롬프트 (치환 완료본)
 * @param {string} p.candidateTags  - 1차 정리 결과 (콤마 한 줄)
 * @param {string} p.danbooruReport - runDanbooruLookup 보고서
 * @param {string} p.targetName
 * @param {string} p.detailInstructions
 * @param {boolean} p.sceneMode
 * @param {string} p.sceneFocus
 * @returns {string}
 */
export function buildPass2(p) {
    let out = (p.refinePrompt || '').trim();
    if ((p.targetName || '').trim()) {
        out += `\n\nTARGET CHARACTER: ${p.targetName.trim()}`;
    }
    out += block('CANDIDATE TAGS', p.candidateTags);
    out += block('DANBOORU LOOKUP RESULTS', p.danbooruReport);
    if (p.sceneMode && (p.sceneFocus || '').trim()) {
        out += block('SCENE FOCUS (for context)', p.sceneFocus);
    }
    if ((p.detailInstructions || '').trim()) {
        out += block('ADDITIONAL USER INSTRUCTIONS', p.detailInstructions);
    }
    out += '\n\nNow output the final refined tags. One single line, comma-separated tags only.';
    return out;
}

/**
 * 장면용 메시지 포맷 (호출측이 chat 배열에서 뽑아 전달)
 * @param {Array<{id?:number, name:string, text:string}>} msgs - 오래된 것 → 최신 순
 *   id가 있으면 "#12 이름: 내용" 형식 (SCENE FOCUS에서 번호로 장면을 지정할 수 있게)
 */
export function formatRecentMessages(msgs) {
    return (msgs || [])
        .map(m => `${Number.isInteger(m.id) ? `#${m.id} ` : ''}${m.name}: ${sanitizeMsg(m.text)}`)
        .join('\n---\n');
}

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };

/**
 * 메시지 텍스트 경량 정리 (정규식만 사용 — DOM 파싱/innerHTML 미사용이라 메시지 속 스크립트·이미지가 실행/로드될 여지 없음)
 * - <style>/<script> 블록은 내용째 제거 (상태창 CSS 등이 토큰을 낭비하지 않게)
 * - HTML 주석 제거, 나머지 태그는 공백으로, 기본 엔티티 복원, 과도한 공백 축소
 */
export function sanitizeMsg(text) {
    return String(text || '')
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<[^>]{1,500}>/g, ' ')
        .replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, e => ENTITIES[e])
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/ *\n */g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}
