/**
 * NAI Tag Extractor - Danbooru 조회 (순수 모듈, fetch 주입식 → node 테스트 가능)
 *
 * 설계 원칙:
 * - 읽기 전용 GET만 사용 (비로그인 CORS 허용 범위)
 * - 배치 조회 우선 (tags.json / tag_aliases.json 은 콤마 목록 지원) → 요청 수 최소화
 * - 요청 간 스로틀 (기본 400ms) + 결과 캐시 (호출측이 저장소에 영속화)
 * - 어떤 실패도 확장 전체를 죽이지 않음: 실패 시 available=false 로 표시하고 나머지는 진행
 */

import { stripWeight, normalizeForDanbooru } from './postproc.js';

const BASE = 'https://danbooru.donmai.us';
const CAT_NAME = { 0: 'general', 1: 'artist', 3: 'copyright', 4: 'character', 5: 'meta' };

const LIMITS = {
    verifyChunk: 50,      // tags.json 배치 크기
    singleRetryMax: 20,   // 배치 미확인 태그 단건 재확인 최대 개수
    autocompleteMax: 12,  // 미확인 태그 근접 검색 최대 개수
    relatedMax: 5,        // related_tag 조회 대상 최대 개수
    throttleMs: 400,
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Danbooru 클라이언트 생성
 * @param {Object} opts
 * @param {Function} opts.fetchFn - fetch 함수 (주입)
 * @param {Object}   opts.cache   - { [normTag]: {name, post_count, category} | {miss:true} }
 * @param {Function} [opts.onProgress] - (msg) => void
 */
export function createDanbooruClient({ fetchFn, cache = {}, onProgress = () => {} }) {
    let lastRequest = 0;
    let available = true;
    let failReason = '';

    async function getJSON(path, params) {
        if (!available) throw new Error('danbooru unavailable: ' + failReason);
        const wait = LIMITS.throttleMs - (Date.now() - lastRequest);
        if (wait > 0) await sleep(wait);
        lastRequest = Date.now();

        const qs = new URLSearchParams(params).toString();
        const url = `${BASE}${path}?${qs}`;
        let res;
        try {
            res = await fetchFn(url, { method: 'GET' });
        } catch (e) {
            available = false;
            failReason = `네트워크/CORS 실패 (${e.message})`;
            throw e;
        }
        if (res.status === 429) {
            // 1회 백오프 재시도
            await sleep(1500);
            res = await fetchFn(url, { method: 'GET' });
        }
        if (!res.ok) {
            if (res.status === 403 || res.status === 401) {
                available = false;
                failReason = `HTTP ${res.status} (접근 차단 가능성)`;
            }
            throw new Error(`danbooru HTTP ${res.status}`);
        }
        return await res.json();
    }

    /** 배치 존재 확인 + 단건 폴백.
     *  danbooru의 콤마 일괄검색(search[name]=a,b,c)은 문서상 지원이지만 빈 배열을 반환하는
     *  사례가 보고되어 있어(#4289), 배치에서 못 찾은 태그는 단건 조회로 재확인한다.
     *  miss 캐싱은 단건 조회로 확정된 경우에만 수행한다 (캐시 오염 방지). */
    async function verifyTags(normTags) {
        const need = normTags.filter(t => !(t in cache));
        const batchMiss = [];
        for (let i = 0; i < need.length; i += LIMITS.verifyChunk) {
            const chunk = need.slice(i, i + LIMITS.verifyChunk);
            onProgress(`단부루 태그 확인 중... (${i + chunk.length}/${need.length})`);
            const rows = await getJSON('/tags.json', {
                'search[name]': chunk.join(','),
                'limit': String(Math.min(chunk.length, 100)),
                'only': 'name,post_count,category',
            });
            const found = new Set();
            for (const row of rows || []) {
                if (!row?.name) continue;
                cache[row.name] = { name: row.name, post_count: row.post_count ?? 0, category: row.category ?? 0 };
                found.add(row.name);
            }
            for (const t of chunk) {
                if (!found.has(t)) batchMiss.push(t);
            }
        }

        // 단건 재확인 (상한 내)
        let retried = 0;
        for (const t of batchMiss) {
            if (!client_available()) break;
            if (retried >= LIMITS.singleRetryMax) break;
            retried++;
            onProgress(`단부루 단건 재확인... (${retried}/${Math.min(batchMiss.length, LIMITS.singleRetryMax)})`);
            try {
                const rows = await getJSON('/tags.json', {
                    'search[name]': t,
                    'limit': '1',
                    'only': 'name,post_count,category',
                });
                const row = (rows || [])[0];
                if (row?.name === t) {
                    cache[t] = { name: row.name, post_count: row.post_count ?? 0, category: row.category ?? 0 };
                } else {
                    cache[t] = { miss: true }; // 단건으로 확정된 miss만 캐싱
                }
            } catch (e) {
                break; // 이후 태그는 이번 실행에서만 미확인 처리 (캐싱 안 함)
            }
        }

        const result = {};
        for (const t of normTags) result[t] = cache[t] || { miss: true };
        return result;
    }

    function client_available() { return available; }

    /** 별칭 배치 조회: miss 태그에 대해 antecedent → consequent */
    async function lookupAliases(missTags) {
        if (!missTags.length) return {};
        const out = {};
        for (let i = 0; i < missTags.length; i += LIMITS.verifyChunk) {
            const chunk = missTags.slice(i, i + LIMITS.verifyChunk);
            onProgress('단부루 별칭 확인 중...');
            const rows = await getJSON('/tag_aliases.json', {
                'search[antecedent_name]': chunk.join(','),
                'search[status]': 'active',
                'limit': '100',
                'only': 'antecedent_name,consequent_name,status',
            });
            for (const row of rows || []) {
                if (row?.antecedent_name && row?.consequent_name) {
                    out[row.antecedent_name] = row.consequent_name;
                }
            }
        }
        return out;
    }

    /** 근접 태그 검색 (미확인 태그 개별, 상한 있음) */
    async function autocomplete(query) {
        const rows = await getJSON('/autocomplete.json', {
            'search[query]': query,
            'search[type]': 'tag_query',
            'version': '1',
            'limit': '5',
        });
        return (rows || [])
            .filter(r => r && (r.type === 'tag' || r.value))
            .map(r => ({
                name: r.value || r.label,
                post_count: r.post_count ?? 0,
                category: r.category ?? 0,
            }));
    }

    /** 연관 태그 조회 */
    async function relatedTags(tag) {
        const data = await getJSON('/related_tag.json', {
            'search[query]': tag,
            'limit': '10',
        });
        const list = [];
        if (Array.isArray(data?.related_tags)) {
            for (const rt of data.related_tags) {
                const t = rt?.tag || rt;
                if (t?.name) list.push({ name: t.name, post_count: t.post_count ?? 0, category: t.category ?? 0 });
            }
        } else if (Array.isArray(data?.tags)) {
            for (const pair of data.tags) {
                if (Array.isArray(pair) && pair[0]) list.push({ name: pair[0], post_count: 0, category: 0 });
            }
        }
        return list.slice(0, 10);
    }

    return {
        verifyTags, lookupAliases, autocomplete, relatedTags,
        isAvailable: () => available,
        failReason: () => failReason,
        getCache: () => cache,
    };
}

/**
 * 후보 태그 전체에 대한 조회 파이프라인 실행 → 보고서 데이터 생성
 * @param {Object} client - createDanbooruClient 결과
 * @param {string[]} candidateTags - 1차 결과 태그 (가중치 포함 가능)
 * @param {boolean} useRelated
 * @returns {Promise<{report: string, summary: Object, degraded: boolean, degradeReason: string}>}
 */
export async function runDanbooruLookup(client, candidateTags, useRelated) {
    const summary = { verified: [], aliased: [], similar: [], notFound: [], related: [] };
    let degraded = false;
    let degradeReason = '';

    // 정규화 매핑 (원형 보존)
    const items = candidateTags.map(orig => {
        const { core } = stripWeight(orig);
        return { orig, core, norm: normalizeForDanbooru(core) };
    }).filter(it => it.norm.length > 0);
    const uniqueNorms = [...new Set(items.map(it => it.norm))];

    try {
        // 1) 배치 존재 확인
        const verified = await client.verifyTags(uniqueNorms);
        const missList = uniqueNorms.filter(t => verified[t]?.miss);

        // 2) 별칭 교정
        let aliases = {};
        try {
            aliases = await client.lookupAliases(missList);
        } catch (e) {
            degraded = true; degradeReason = '별칭 조회 실패: ' + e.message;
        }

        // 별칭 결과(consequent) 존재 확인에 추가
        const aliasTargets = [...new Set(Object.values(aliases))].filter(t => !(t in client.getCache()));
        if (aliasTargets.length) {
            try { await client.verifyTags(aliasTargets); } catch (e) { /* 보고서엔 이름만 표기 */ }
        }

        // 3) 미확인 태그 근접 검색 (상한)
        const stillMiss = missList.filter(t => !aliases[t]);
        const similar = {};
        let acCount = 0;
        for (const t of stillMiss) {
            if (acCount >= LIMITS.autocompleteMax || !client.isAvailable()) break;
            try {
                // 언더스코어 → 공백 쿼리가 자동완성 매칭에 더 잘 걸린다
                const rows = await client.autocomplete(t.replace(/_/g, ' '));
                if (rows.length) similar[t] = rows;
                acCount++;
            } catch (e) {
                degraded = true; degradeReason = '근접 검색 일부 실패: ' + e.message;
                break;
            }
        }

        // 4) 연관 태그 (검증된 general 태그 상위 N개)
        const relatedMap = {};
        if (useRelated) {
            const bases = uniqueNorms
                .filter(t => verified[t] && !verified[t].miss && (verified[t].category ?? 0) === 0)
                .sort((a, b) => (verified[b].post_count || 0) - (verified[a].post_count || 0))
                .slice(0, LIMITS.relatedMax);
            for (const t of bases) {
                if (!client.isAvailable()) break;
                try {
                    const rel = await client.relatedTags(t);
                    if (rel.length) relatedMap[t] = rel;
                } catch (e) {
                    degraded = true; degradeReason = '연관 태그 일부 실패: ' + e.message;
                    break;
                }
            }
        }

        // 5) 보고서 조립
        const lines = [];
        for (const t of uniqueNorms) {
            const v = verified[t];
            if (v && !v.miss) {
                const cat = CAT_NAME[v.category] || 'general';
                lines.push(`[VERIFIED] ${t} (${cat}, ${fmtCount(v.post_count)} posts)`);
                summary.verified.push(t);
            } else if (aliases[t]) {
                lines.push(`[ALIAS] ${t} -> use "${aliases[t]}"`);
                summary.aliased.push({ from: t, to: aliases[t] });
            } else if (similar[t]) {
                const s = similar[t].map(r => `${r.name}(${fmtCount(r.post_count)})`).join(', ');
                lines.push(`[NOT FOUND] ${t} | similar existing tags: ${s}`);
                summary.similar.push({ tag: t, options: similar[t].map(r => r.name) });
                summary.notFound.push(t);
            } else {
                lines.push(`[NOT FOUND] ${t} | no close match — keep as natural language if needed`);
                summary.notFound.push(t);
            }
        }
        for (const [base, rel] of Object.entries(relatedMap)) {
            const s = rel.map(r => `${r.name}(${fmtCount(r.post_count)})`).join(', ');
            lines.push(`[RELATED to ${base}] ${s}`);
            summary.related.push({ base, tags: rel.map(r => r.name) });
        }

        if (!client.isAvailable()) {
            degraded = true;
            degradeReason = degradeReason || client.failReason();
        }
        return { report: lines.join('\n'), summary, degraded, degradeReason };
    } catch (e) {
        // 전체 실패 → 호출측이 1차 결과로 폴백
        return { report: '', summary, degraded: true, degradeReason: e.message };
    }
}

function fmtCount(n) {
    if (!Number.isFinite(n)) return '0';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(0) + 'k';
    return String(n);
}
