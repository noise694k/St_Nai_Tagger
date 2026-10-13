/**
 * NAI Tag Extractor - 태그 저장소 데이터 로직 (순수 모듈, ST 비의존, node 테스트 가능)
 * 저장 자체는 호출측(app.js)이 IndexedDB에 수행한다.
 * 원칙: 어떤 처리도 유저 데이터를 조용히 자르거나 바꾸지 않는다 — 한도 초과 항목은 "거부 + 개수 보고".
 */

export const LIB_CATEGORIES = [
    { id: 'character', label: '캐릭터' },
    { id: 'main', label: '메인프롬' },
    { id: 'uc', label: 'UC' },
    { id: 'scene', label: '장면' },
];
const CATEGORY_IDS = LIB_CATEGORIES.map(c => c.id);

export const LIB_LIMITS = { title: 100, content: 20000, memo: 5000, items: 1000 };

export function categoryLabel(id) {
    return LIB_CATEGORIES.find(c => c.id === id)?.label || id;
}

export function newId() {
    return `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 항목 검증/정규화. 필수값 누락·한도 초과면 null (자르지 않음)
 * @returns {Object|null}
 */
export function normalizeItem(raw, now = Date.now()) {
    if (!raw || typeof raw !== 'object') return null;
    const content = typeof raw.content === 'string' ? raw.content.trim() : '';
    const title = String(raw.title ?? '').trim();
    const memo = String(raw.memo ?? '').trim();
    if (!content) return null;
    if (content.length > LIB_LIMITS.content || title.length > LIB_LIMITS.title || memo.length > LIB_LIMITS.memo) return null;
    const createdAt = Number.isFinite(raw.createdAt) ? raw.createdAt : now;
    return {
        id: (typeof raw.id === 'string' && /^[\w-]{4,64}$/.test(raw.id)) ? raw.id : newId(),
        category: CATEGORY_IDS.includes(raw.category) ? raw.category : 'character',
        title,
        content,
        memo,
        createdAt,
        updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : createdAt,
    };
}

/** id 기준 교체 또는 추가 (새 배열 반환) */
export function upsertItem(list, item) {
    const out = (list || []).slice();
    const i = out.findIndex(x => x.id === item.id);
    if (i >= 0) out[i] = item;
    else out.push(item);
    return out;
}

export function removeItem(list, id) {
    return (list || []).filter(x => x.id !== id);
}

/** 분류/검색 필터 + 최근 수정순 정렬 */
export function filterItems(list, { category = 'all', query = '' } = {}) {
    const q = String(query || '').trim().toLowerCase();
    return (list || [])
        .filter(x => category === 'all' || x.category === category)
        .filter(x => !q
            || x.title.toLowerCase().includes(q)
            || x.memo.toLowerCase().includes(q)
            || x.content.toLowerCase().includes(q))
        .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function countByCategory(list) {
    const c = { all: 0 };
    for (const cat of CATEGORY_IDS) c[cat] = 0;
    for (const x of list || []) { c.all++; if (x.category in c) c[x.category]++; }
    return c;
}

/**
 * 가져오기 병합 — 기존 항목은 절대 삭제하지 않는다.
 * - 같은 id: 가져온 쪽이 더 최근 수정본일 때만 교체
 * - 다른 id인데 분류·제목·내용이 완전히 같음: 중복으로 건너뜀
 * @returns {{list:Array, added:number, updated:number, skipped:number, invalid:number, overflow:number}}
 */
export function mergeImport(list, incoming, now = Date.now()) {
    const out = (list || []).slice();
    const r = { added: 0, updated: 0, skipped: 0, invalid: 0, overflow: 0 };
    for (const raw of incoming || []) {
        const it = normalizeItem(raw, now);
        if (!it) { r.invalid++; continue; }
        const idx = out.findIndex(x => x.id === it.id);
        if (idx >= 0) {
            if (it.updatedAt > out[idx].updatedAt) { out[idx] = it; r.updated++; }
            else r.skipped++;
            continue;
        }
        if (out.some(x => x.category === it.category && x.title === it.title && x.content === it.content)) {
            r.skipped++;
            continue;
        }
        if (out.length >= LIB_LIMITS.items) { r.overflow++; continue; }
        out.push(it);
        r.added++;
    }
    return { list: out, ...r };
}

export function buildLibraryExport(list) {
    return {
        ext: 'st-nai-tagger',
        kind: 'prompt-library',
        version: 1,
        exported: new Date().toISOString(),
        items: list || [],
    };
}

/** 가져오기 파일 해석: 저장소 파일 / 전체 백업 파일 / 배열 모두 허용 */
export function parseLibraryImport(data) {
    if (Array.isArray(data)) return data;
    if (data && typeof data === 'object') {
        if (data.kind === 'prompt-library' && Array.isArray(data.items)) return data.items;
        if (data.ext === 'st-nai-tagger' && Array.isArray(data.library)) return data.library;
        if (data.ext === 'st-nai-tagger') throw new Error('이 백업 파일에는 저장된 프롬프트가 없습니다.');
    }
    throw new Error('NAI 태그 추출기의 프롬프트 파일이 아닙니다.');
}
