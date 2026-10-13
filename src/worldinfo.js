/**
 * NAI Tag Extractor - 월드인포 읽기 (읽기 전용)
 * 대상: (1) 현재 캐릭터에 연결된 외부 WI북 (2) 캐릭터 카드 내장 로어북(character_book)
 * 어떤 WI 데이터도 수정하지 않는다.
 */

import { stContext, requestHeaders } from './stcore.js';

/** 엔트리 고유키 (선택 저장용): 출처|uid|키워드요약 */
export function entryKey(e) {
    return `${e.source}|${e.uid}|${(e.keys || []).slice(0, 3).join(',')}`;
}

function toEntry(raw, source, idx) {
    if (!raw) return null;
    return {
        uid: raw.id ?? raw.uid ?? idx,
        keys: raw.keys || raw.key || [],
        comment: raw.comment || raw.name || '',
        content: raw.content || '',
        enabled: raw.enabled !== false && raw.disable !== true,
        source,
    };
}

function fromBook(book, source) {
    if (!book?.entries) return [];
    const raws = Array.isArray(book.entries) ? book.entries : Object.values(book.entries);
    return raws.map((r, i) => toEntry(r, source, i)).filter(Boolean);
}

async function fetchBook(name) {
    try {
        const res = await fetch('/api/worldinfo/get', {
            method: 'POST',
            headers: { ...requestHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ name }),
        });
        if (res.ok) return fromBook(await res.json(), name);
    } catch (e) { /* fallthrough */ }
    return [];
}

/** 현재 캐릭터 기준 WI 엔트리 로드 (연결북 + 내장 로어북, content 해시 중복 제거) */
export async function loadCurrentCharacterWI() {
    const ctx = stContext();
    const char = ctx?.characters?.[ctx?.characterId];
    if (!char) return { charName: '', entries: [] };

    const entries = [];
    const seen = new Set();
    const push = (list) => {
        for (const e of list) {
            const h = `${(e.content || '').substring(0, 300)}`;
            if (seen.has(h)) continue;
            seen.add(h);
            entries.push(e);
        }
    };

    const worldName = char?.data?.extensions?.world;
    if (worldName) push(await fetchBook(worldName));

    const embedded = char?.data?.character_book;
    if (embedded) push(fromBook(embedded, '내장 로어북'));

    return { charName: char?.name || '', entries };
}

/** 현재 캐릭터 식별자 (선택 저장 키) */
export function currentCharKey() {
    const ctx = stContext();
    const char = ctx?.characters?.[ctx?.characterId];
    return char?.avatar || char?.name || '';
}

/** 선택된 엔트리 → 프롬프트 블록 문자열 */
export function entriesToText(entries) {
    return entries.map(e => {
        const head = e.comment || (e.keys || []).join(', ') || `entry ${e.uid}`;
        return `<<${head}>>\n${e.content}`;
    }).join('\n\n');
}
