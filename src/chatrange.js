/**
 * NAI Tag Extractor - 장면용 메시지 선택 (순수 모듈, ST 비의존, node 테스트 가능)
 * 메시지 번호는 ST 화면에 표시되는 #번호(= chat 배열 인덱스, 0부터)와 같다.
 * 읽기 전용: chat 배열을 절대 수정하지 않는다.
 */

/** "12", "#12", " 12 " → 12 / 빈 값 → null / 그 외 → NaN */
export function parseMsgNumber(v) {
    const s = String(v ?? '').trim().replace(/^#/, '').trim();
    if (s === '') return null;
    if (!/^\d+$/.test(s)) return NaN;
    return Number(s);
}

function speakerOf(m) {
    return m?.name || (m?.is_user ? 'User' : 'Char');
}

/**
 * @param {Array} chat - ST chat 배열
 * @param {Object} opt
 * @param {'recent'|'range'} opt.mode
 * @param {number} [opt.count]   - recent 모드: 가져올 개수
 * @param {*} [opt.start]        - range 모드: 시작 번호
 * @param {*} [opt.end]          - range 모드: 끝 번호 (빈 값 = 마지막까지)
 * @returns {{ok:boolean, error?:string, msgs:Array<{id:number,name:string,text:string}>,
 *            from:number|null, to:number|null, lastId:number, hidden:number, notes:string[]}}
 *   hidden: recent 모드에선 건너뛴 숨김 메시지 수, range 모드에선 포함된 숨김 메시지 수
 */
export function selectSceneMessages(chat, opt = {}) {
    const list = Array.isArray(chat) ? chat : [];
    const lastId = list.length - 1;
    const res = { ok: false, msgs: [], from: null, to: null, lastId, hidden: 0, notes: [] };

    if (list.length === 0) {
        res.error = '채팅이 비어 있습니다.';
        return res;
    }

    if (opt.mode === 'range') {
        let start = parseMsgNumber(opt.start);
        let end = parseMsgNumber(opt.end);
        if (start === null) { res.error = '시작 번호를 입력해주세요.'; return res; }
        if (Number.isNaN(start) || Number.isNaN(end)) { res.error = '번호는 숫자로 입력해주세요 (예: 12 또는 #12).'; return res; }
        if (end === null) {
            end = lastId; // 끝 비움 = 마지막까지 (이 경우 순서 교정 없음)
        } else if (start > end) {
            [start, end] = [end, start];
            res.notes.push('시작/끝 순서를 바꿔 적용');
        }
        if (start > lastId) { res.error = `#${start} 메시지가 없습니다 (마지막 #${lastId}).`; return res; }
        if (end > lastId) { res.notes.push(`끝 번호를 마지막 #${lastId}로 조정`); end = lastId; }

        // 명시적 범위: 숨김(is_system) 메시지도 포함 — 숨겨둔 과거 장면을 고르는 경우를 위해
        for (let i = start; i <= end; i++) {
            const m = list[i];
            if (!m || typeof m.mes !== 'string' || !m.mes.trim()) continue;
            if (m.is_system) res.hidden++;
            res.msgs.push({ id: i, name: speakerOf(m), text: m.mes });
        }
        res.from = start;
        res.to = end;
    } else {
        const n = Math.max(1, Math.floor(Number(opt.count) || 1));
        for (let i = lastId; i >= 0 && res.msgs.length < n; i--) {
            const m = list[i];
            if (!m || typeof m.mes !== 'string' || !m.mes.trim()) continue;
            if (m.is_system) { res.hidden++; continue; }
            res.msgs.push({ id: i, name: speakerOf(m), text: m.mes });
        }
        res.msgs.reverse();
        if (res.msgs.length) {
            res.from = res.msgs[0].id;
            res.to = res.msgs[res.msgs.length - 1].id;
        }
    }

    if (!res.msgs.length) {
        res.error = '선택된 범위에 내용이 있는 메시지가 없습니다.';
        return res;
    }
    res.ok = true;
    return res;
}

/** UI 안내문 (모바일에서 선택 결과를 바로 확인하는 용도) */
export function describeSelection(sel, mode) {
    if (!sel) return '';
    if (!sel.ok) {
        return `⚠️ ${sel.error}${sel.lastId >= 0 ? ` · 현재 마지막 메시지 #${sel.lastId}` : ''}`;
    }
    const chars = sel.msgs.reduce((a, m) => a + m.text.length, 0);
    let s = `→ #${sel.from}~#${sel.to} · ${sel.msgs.length}개 메시지 · 약 ${chars.toLocaleString()}자`;
    if (sel.hidden) s += mode === 'range' ? ` (숨김 ${sel.hidden}개 포함)` : ` (숨김 ${sel.hidden}개 제외)`;
    if (sel.notes.length) s += ` · ${sel.notes.join(', ')}`;
    s += ` · 마지막 메시지 #${sel.lastId}`;
    return s;
}
