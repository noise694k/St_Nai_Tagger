/**
 * NAI Tag Extractor - UI
 * ST 확장 설정 패널에 드로어를 추가한다. DOM만 다루며 ST 내부 상태는 건드리지 않는다.
 * 성능: 주기적 DOM 스캔 없음. 목록은 이벤트 위임 + 페이지 단위 렌더 + 고정 높이 스크롤 영역.
 */

import { PROVIDERS, MODEL_LISTS, PROMPT_DEFAULTS, promptOf, normalizePromptValue } from './defaults.js';
import {
    app, saveSettings, loadWIForCurrentChar, saveWISelection, buildPreview, runExtraction, testDanbooru,
    getHistory, deleteHistoryAt, getSceneSelection, saveLibrary, buildFullBackup, applyFullBackup, wipeAll,
} from './app.js';
import { entryKey } from './worldinfo.js';
import { describeSelection } from './chatrange.js';
import {
    LIB_CATEGORIES, LIB_LIMITS, categoryLabel, normalizeItem, upsertItem, removeItem, filterItems,
    countByCategory, mergeImport, buildLibraryExport, parseLibraryImport,
} from './library.js';
import { toast, confirmPopup, stContext } from './stcore.js';

const P = 'nait'; // css/id prefix
const LIB_PAGE = 30;

/** 항상 현재 설정 객체를 참조 (가져오기/전체삭제로 객체가 교체돼도 안전) */
const S = () => app.settings;

function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function $id(id) { return document.getElementById(`${P}-${id}`); }
function debounce(fn, ms) {
    let t = null;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
function pad2(n) { return String(n).padStart(2, '0'); }
function fmtDate(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
function stamp() {
    const d = new Date();
    return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}`;
}

const PROMPT_LABELS = {
    base_prompt: '기본 추출 프롬프트',
    scene_prompt: '장면 추출 프롬프트',
    refine_prompt: '단부루 보정 프롬프트 (2차)',
};

// 저장소 UI 상태 (메모리 전용)
const lib = { cat: 'all', query: '', limit: LIB_PAGE, editingId: null };

// ===== 패널 HTML =====

function panelHTML() {
    const provOpts = PROVIDERS.map(p => `<option value="${p}">${p}</option>`).join('');
    const promptOpts = Object.keys(PROMPT_DEFAULTS).map(k => `<option value="${k}">${esc(PROMPT_LABELS[k])}</option>`).join('');
    const catOpts = LIB_CATEGORIES.map(c => `<option value="${c.id}">${esc(c.label)}</option>`).join('');
    return `
<div id="${P}-root" class="${P}-ext">
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
      <b>NAI 태그 추출기</b>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content">

      <!-- 연결 설정 -->
      <details class="${P}-sec">
        <summary>연결 설정</summary>
        <label class="${P}-lbl">프로바이더</label>
        <select id="${P}-provider" class="text_pole">${provOpts}</select>
        <label class="${P}-lbl">모델</label>
        <select id="${P}-model" class="text_pole"></select>
        <label class="${P}-chk"><input type="checkbox" id="${P}-use-custom-model"> 모델명 직접 입력</label>
        <input type="text" id="${P}-custom-model" class="text_pole" placeholder="모델명 직접 입력" style="display:none">
        <label class="${P}-chk"><input type="checkbox" id="${P}-use-proxy"> 리버스프록시 사용</label>
        <div id="${P}-proxy-box" style="display:none">
          <input type="text" id="${P}-proxy-url" class="text_pole" placeholder="프록시 URL">
          <input type="password" id="${P}-proxy-pw" class="text_pole" placeholder="프록시 비밀번호 (선택)">
        </div>
        <div class="${P}-row2">
          <div><label class="${P}-lbl">Max Tokens</label><input type="number" id="${P}-max-tokens" class="text_pole" min="0" step="64"></div>
          <div><label class="${P}-lbl">Temperature</label><input type="number" id="${P}-temp" class="text_pole" min="0" max="2" step="0.1"></div>
        </div>
        <small class="${P}-hint">응답이 잘리는 경우 Max Tokens를 늘리세요.</small>
        <label class="${P}-chk"><input type="checkbox" id="${P}-prefill"> 프리필 사용</label>
        <textarea id="${P}-prefill-content" class="text_pole ${P}-ta-s" style="display:none" placeholder="프리필 내용"></textarea>
      </details>

      <!-- 추출 설정 -->
      <details id="${P}-extract-sec" class="${P}-sec">
        <summary>추출 설정</summary>
        <label class="${P}-lbl">대상 캐릭터 이름 <small>(비우면 현재 캐릭터)</small></label>
        <input type="text" id="${P}-target" class="text_pole" placeholder="캐릭터 이름">

        <label class="${P}-lbl">인풋 소스</label>
        <label class="${P}-chk"><input type="checkbox" id="${P}-src-char"> 캐릭터 프로필 (description + personality)</label>
        <label class="${P}-chk"><input type="checkbox" id="${P}-src-persona"> 유저 프로필 (persona)</label>
        <label class="${P}-chk"><input type="checkbox" id="${P}-src-wi"> 월드인포 (아래에서 엔트리 선택)</label>
        <div id="${P}-wi-box" style="display:none">
          <button id="${P}-wi-load" class="menu_button">현재 캐릭터의 월드인포 불러오기</button>
          <div id="${P}-wi-list" class="${P}-wi-list"></div>
        </div>

        <label class="${P}-chk" style="margin-top:8px"><input type="checkbox" id="${P}-scene"> 장면 프롬프트 모드</label>
        <div id="${P}-scene-box" style="display:none">
          <label class="${P}-lbl">메시지 선택 방식</label>
          <label class="${P}-chk"><input type="radio" name="${P}-scene-sel" value="recent"> 최근 메시지 N개</label>
          <label class="${P}-chk"><input type="radio" name="${P}-scene-sel" value="range"> 메시지 번호 범위 (#시작 ~ #끝)</label>
          <div id="${P}-scene-recent-box">
            <label class="${P}-lbl">최근 메시지 개수</label>
            <input type="number" id="${P}-scene-n" class="text_pole" min="1" max="200" step="1" inputmode="numeric">
          </div>
          <div id="${P}-scene-range-box" style="display:none">
            <div class="${P}-row2">
              <div><label class="${P}-lbl">시작 #</label><input type="number" id="${P}-scene-start" class="text_pole" min="0" step="1" inputmode="numeric" placeholder="예: 12"></div>
              <div><label class="${P}-lbl">끝 #</label><input type="number" id="${P}-scene-end" class="text_pole" min="0" step="1" inputmode="numeric" placeholder="비우면 마지막까지"></div>
            </div>
            <small class="${P}-hint">번호는 채팅 화면의 메시지 번호(#)와 같습니다. 범위 지정 시 숨김 메시지도 포함됩니다.</small>
          </div>
          <div class="${P}-row-flex ${P}-info-row">
            <span id="${P}-scene-info" class="${P}-hint"></span>
            <button id="${P}-scene-refresh" class="menu_button ${P}-mini" title="채팅 기준으로 다시 확인">↻ 확인</button>
          </div>
          <label class="${P}-lbl">원하는 장면 구체 지시</label>
          <textarea id="${P}-scene-focus" class="text_pole ${P}-ta-s"></textarea>
        </div>
      </details>

      <!-- 프롬프트 -->
      <details class="${P}-sec">
        <summary>프롬프트 편집</summary>
        <div class="${P}-row-flex">
          <select id="${P}-prompt-select" class="text_pole">${promptOpts}</select>
          <button id="${P}-prompt-reset" class="menu_button" title="기본값 복원">초기화</button>
        </div>
        <textarea id="${P}-prompt-editor" class="text_pole ${P}-ta-l"></textarea>
        <small id="${P}-prompt-state" class="${P}-hint"></small>
        <small class="${P}-hint">ST 매크로({{char}}, {{description}}, {{persona}} 등) 사용 가능</small>
        <label class="${P}-lbl">상세 지시사항 <small>(선택, 항상 추가되며 최우선 지시로 취급 — 장면/분위기를 적으면 장면 모드 없이도 해당 장면 태그가 출력됩니다)</small></label>
        <textarea id="${P}-detail" class="text_pole ${P}-ta-s" placeholder="예: long hair, green eyes 강조"></textarea>

        <!-- Raw Prompt (프롬프트 편집 하위) -->
        <details class="${P}-sec ${P}-sub-sec">
          <summary>Raw Prompt 미리보기</summary>
          <button id="${P}-preview-btn" class="menu_button">미리보기 갱신 (1차 전문)</button>
          <div id="${P}-preview-tokens" class="${P}-hint"></div>
          <textarea id="${P}-preview" class="text_pole ${P}-ta-l" readonly></textarea>
          <button id="${P}-preview-p2" class="menu_button" style="display:none">마지막 실행의 2차 전문 보기</button>
        </details>
      </details>

      <!-- 태그 추출하기 -->
      <details id="${P}-run-sec" class="${P}-sec">
        <summary>✨ 태그 추출하기</summary>
        <!-- 체크박스 열 + 내용 열 그리드: 안내문·하위 옵션이 항상 '문구' 시작선에 맞춰 정렬됨 (테마별 체크박스 크기와 무관) -->
        <div class="${P}-opt">
          <input type="checkbox" id="${P}-danbooru">
          <label for="${P}-danbooru">Danbooru 태그 보정 사용</label>
          <small class="${P}-hint ${P}-opt-col">체크 시 LLM API 호출이 1회 추가됩니다 (2단계 보정)</small>
          <div id="${P}-danbooru-box" class="${P}-opt-col" style="display:none">
            <label class="${P}-chk"><input type="checkbox" id="${P}-danbooru-related"> 연관 태그 추가 제안 포함</label>
            <button id="${P}-danbooru-test" class="menu_button">단부루 연결 테스트</button>
            <div id="${P}-danbooru-test-result" class="${P}-hint"></div>
          </div>
        </div>

        <button id="${P}-run" class="menu_button ${P}-run-btn">태그 추출</button>
        <div id="${P}-status" class="${P}-status"></div>

        <div class="${P}-result-wrap">
          <div class="${P}-result-head">
            <span>결과</span>
            <span class="${P}-btn-group">
              <button id="${P}-save-result" class="menu_button ${P}-mini" title="태그 저장소에 저장">💾 저장</button>
              <button id="${P}-copy" class="menu_button ${P}-mini" title="전체 복사">📋 복사</button>
            </span>
          </div>
          <textarea id="${P}-result" class="text_pole ${P}-ta-l" readonly placeholder="추출 결과가 여기에 표시됩니다"></textarea>
          <div id="${P}-danbooru-summary" class="${P}-hint"></div>
        </div>
      </details>

      <!-- 태그 저장소 -->
      <details id="${P}-lib-sec" class="${P}-sec">
        <summary>태그 저장소 <span id="${P}-lib-count" class="${P}-hint ${P}-inline"></span></summary>
        <div class="${P}-row-flex ${P}-wrap">
          <button id="${P}-lib-new" class="menu_button">+ 새 항목</button>
          <button id="${P}-lib-export" class="menu_button">내보내기</button>
          <button id="${P}-lib-import" class="menu_button">불러오기</button>
        </div>
        <input type="file" id="${P}-lib-import-file" accept=".json,application/json" style="display:none">

        <div id="${P}-lib-form" class="${P}-lib-form" style="display:none">
          <b id="${P}-lib-form-title">새 항목</b>
          <label class="${P}-lbl">분류</label>
          <select id="${P}-lib-f-cat" class="text_pole">${catOpts}</select>
          <label class="${P}-lbl">제목 <small>(비우면 자동)</small></label>
          <input type="text" id="${P}-lib-f-title" class="text_pole" maxlength="${LIB_LIMITS.title}">
          <label class="${P}-lbl">프롬프트</label>
          <textarea id="${P}-lib-f-content" class="text_pole ${P}-ta-m" maxlength="${LIB_LIMITS.content}"></textarea>
          <label class="${P}-lbl">메모 <small>(선택 · 어떤 상황/캐릭터인지 등)</small></label>
          <textarea id="${P}-lib-f-memo" class="text_pole ${P}-ta-s" maxlength="${LIB_LIMITS.memo}" placeholder="제목만으로 구분이 어려운 경우 부가 설명"></textarea>
          <div class="${P}-row-flex">
            <button id="${P}-lib-f-save" class="menu_button">저장</button>
            <button id="${P}-lib-f-cancel" class="menu_button">취소</button>
          </div>
        </div>

        <div id="${P}-lib-chips" class="${P}-chips"></div>
        <input type="search" id="${P}-lib-search" class="text_pole" placeholder="제목·메모·내용 검색">
        <div id="${P}-lib-list" class="${P}-lib-list"></div>
        <button id="${P}-lib-more" class="menu_button ${P}-full" style="display:none"></button>
      </details>

      <!-- 히스토리 -->
      <details class="${P}-sec">
        <summary>히스토리</summary>
        <label class="${P}-lbl">저장 개수 <small>(0 = 저장 안 함)</small></label>
        <input type="number" id="${P}-hist-limit" class="text_pole" min="0" max="100" step="1">
        <div id="${P}-hist-list" class="${P}-hist-list"></div>
      </details>

      <!-- 전송 로그 -->
      <details class="${P}-sec">
        <summary>전송 로그</summary>
        <div id="${P}-log" class="${P}-log"></div>
      </details>

      <!-- 데이터 관리 -->
      <details class="${P}-sec">
        <summary>데이터 관리</summary>
        <small class="${P}-hint">모든 데이터는 브라우저의 IndexedDB에만 저장됩니다. 전체 백업 = 설정 + 히스토리 + 태그 저장소. 가져오면 설정·히스토리는 교체되고, 태그 저장소는 기존 항목을 지우지 않고 병합됩니다.</small>
        <div class="${P}-row-flex">
          <button id="${P}-export" class="menu_button">전체 백업 내보내기</button>
          <button id="${P}-import" class="menu_button">백업 가져오기</button>
        </div>
        <button id="${P}-wipe" class="menu_button ${P}-danger">모든 데이터 삭제</button>
        <input type="file" id="${P}-import-file" accept=".json,application/json" style="display:none">
      </details>

    </div>
  </div>
</div>`;
}

// ===== 렌더/동기화 =====

function syncModelSelect() {
    const s = S();
    const sel = $id('model');
    const list = MODEL_LISTS[s.provider] || [];
    sel.innerHTML = list.map(m => `<option value="${esc(m)}">${esc(m)}</option>`).join('');
    if (!s.models[s.provider]) s.models[s.provider] = list[0] || '';
    sel.value = s.models[s.provider];
    if (sel.value !== s.models[s.provider]) { // 저장값이 목록에 없는 경우
        const opt = document.createElement('option');
        opt.value = s.models[s.provider];
        opt.textContent = s.models[s.provider];
        sel.appendChild(opt);
        sel.value = s.models[s.provider];
    }
    const useCustom = !!s.use_custom_model[s.provider];
    $id('use-custom-model').checked = useCustom;
    const ci = $id('custom-model');
    ci.style.display = useCustom ? '' : 'none';
    ci.value = s.custom_models[s.provider] || '';
    sel.style.display = useCustom ? 'none' : '';
}

function syncPromptEditor() {
    const key = $id('prompt-select').value;
    $id('prompt-editor').value = promptOf(S(), key);
    updatePromptState(key);
}

function updatePromptState(key) {
    const custom = typeof S()[key] === 'string';
    $id('prompt-state').textContent = custom
        ? '✏️ 수정본 사용 중 — 확장 업데이트 시 그대로 유지됩니다 (초기화하면 최신 기본값 적용)'
        : '기본값 사용 중 — 확장 업데이트 시 새 기본값이 자동 적용됩니다';
}

function syncSceneBoxes() {
    const s = S();
    $id('scene-box').style.display = s.scene_mode ? '' : 'none';
    const mode = s.scene_select_mode === 'range' ? 'range' : 'recent';
    document.querySelectorAll(`input[name="${P}-scene-sel"]`).forEach(r => { r.checked = r.value === mode; });
    $id('scene-recent-box').style.display = mode === 'recent' ? '' : 'none';
    $id('scene-range-box').style.display = mode === 'range' ? '' : 'none';
    updateSceneInfo();
}

function updateSceneInfo() {
    const box = $id('scene-info');
    if (!S().scene_mode) { box.textContent = ''; return; }
    try {
        const sel = getSceneSelection();
        box.textContent = describeSelection(sel, S().scene_select_mode);
        box.classList.toggle(`${P}-err`, !sel.ok);
    } catch (e) {
        box.textContent = `메시지 확인 실패: ${e.message}`;
        box.classList.add(`${P}-err`);
    }
}

function syncAll() {
    const s = S();
    $id('provider').value = s.provider;
    syncModelSelect();
    $id('use-proxy').checked = s.use_reverse_proxy;
    $id('proxy-box').style.display = s.use_reverse_proxy ? '' : 'none';
    $id('proxy-url').value = s.reverse_proxy_url;
    $id('proxy-pw').value = s.reverse_proxy_password;
    $id('max-tokens').value = s.max_tokens;
    $id('temp').value = s.temperature;
    $id('prefill').checked = s.prefill_enabled;
    const pf = $id('prefill-content');
    pf.style.display = s.prefill_enabled ? '' : 'none';
    pf.value = s.prefill_content;

    $id('target').value = s.target_name;
    $id('src-char').checked = s.src_char_profile;
    $id('src-persona').checked = s.src_user_persona;
    $id('src-wi').checked = s.src_worldinfo;
    $id('wi-box').style.display = s.src_worldinfo ? '' : 'none';

    $id('scene').checked = s.scene_mode;
    $id('scene-n').value = s.scene_msg_count;
    $id('scene-start').value = s.scene_range_start;
    $id('scene-end').value = s.scene_range_end;
    $id('scene-focus').value = s.scene_focus;
    syncSceneBoxes();

    $id('detail').value = s.detail_instructions;
    syncPromptEditor();

    $id('danbooru').checked = s.danbooru_enabled;
    $id('danbooru-box').style.display = s.danbooru_enabled ? '' : 'none';
    $id('danbooru-related').checked = s.danbooru_related;

    $id('hist-limit').value = s.history_limit;
}

function renderWIList() {
    const box = $id('wi-list');
    if (!app.wiEntries.length) {
        box.innerHTML = `<small class="${P}-hint">불러온 엔트리가 없습니다.</small>`;
        return;
    }
    box.innerHTML = app.wiEntries.map((e, i) => {
        const k = entryKey(e);
        const label = e.comment || (e.keys || []).join(', ') || `entry ${e.uid}`;
        const checked = app.wiSelected.has(k) ? 'checked' : '';
        const dim = e.enabled ? '' : ` <small>(WI에서 비활성 상태)</small>`;
        return `<label class="${P}-chk"><input type="checkbox" data-wi="${i}" ${checked}> <span title="${esc((e.content || '').slice(0, 200))}">[${esc(e.source)}] ${esc(label)}${dim}</span></label>`;
    }).join('');
}

async function renderHistory() {
    const list = await getHistory();
    const box = $id('hist-list');
    if (!list.length) { box.innerHTML = `<small class="${P}-hint">저장된 결과가 없습니다.</small>`; return; }
    box.innerHTML = list.map((h, i) => {
        const d = new Date(h.ts);
        const meta = `${d.getMonth() + 1}/${d.getDate()} ${pad2(d.getHours())}:${pad2(d.getMinutes())} · ${esc(h.target || '?')}${h.scene ? ' · 장면' : ''}${h.danbooru ? ' · 단부루' : ''}`;
        return `<div class="${P}-hist-item">
            <div class="${P}-hist-meta">${meta}</div>
            <div class="${P}-hist-tags">${esc(h.tags)}</div>
            <div class="${P}-row-flex">
              <button class="menu_button ${P}-mini" data-hact="copy" data-i="${i}">복사</button>
              <button class="menu_button ${P}-mini" data-hact="save" data-i="${i}">💾 저장</button>
              <button class="menu_button ${P}-mini" data-hact="del" data-i="${i}">삭제</button>
            </div>
          </div>`;
    }).join('');
}

function renderLog() {
    const box = $id('log');
    if (!app.sendLog.length) { box.innerHTML = `<small class="${P}-hint">기록이 없습니다.</small>`; return; }
    box.innerHTML = app.sendLog.map(e => {
        const t = new Date(e.ts);
        const time = `${pad2(t.getHours())}:${pad2(t.getMinutes())}:${pad2(t.getSeconds())}`;
        let body = `<b>${esc(e.stage)}</b> ${e.ok ? '✅' : '❌'}`;
        if (e.provider) body += ` · ${esc(e.provider)}/${esc(e.model || '')}`;
        if (e.usage && (e.usage.input != null || e.usage.output != null)) {
            const ap = e.usage.approx ? '약 ' : '';
            body += ` · 입력 ${ap}${e.usage.input ?? '?'} / 출력 ${ap}${e.usage.output ?? '?'}`;
            if (e.usage.thoughts != null) body += ` (+사고 ${e.usage.thoughts})`;
            body += e.usage.approx ? ' tok(추정)' : ' tok';
        } else if (e.chars) {
            body += ` · ${e.chars}자`;
        }
        if (e.ms) body += ` · ${e.ms}ms`;
        if (e.verified !== undefined) body += ` · 검증 ${e.verified} / 미확인 ${e.notFound}`;
        if (e.error) body += `<div class="${P}-err">${esc(e.error)}</div>`;
        if (e.danbooruDetail) {
            const d = e.danbooruDetail;
            let dd = '';
            if (d.verified?.length) dd += `✅ ${d.verified.map(esc).join(', ')}<br>`;
            if (d.aliased?.length) dd += `🔁 ${d.aliased.map(a => `${esc(a.from)}→${esc(a.to)}`).join(', ')}<br>`;
            if (d.notFound?.length) dd += `⚠️ ${d.notFound.map(esc).join(', ')}`;
            if (dd) body += `<div class="${P}-hint">${dd}</div>`;
        }
        if (e.filtered?.length) body += `<div class="${P}-hint">후처리로 제거된 줄:<br>${e.filtered.map(esc).join('<br>')}</div>`;
        return `<div class="${P}-log-item"><span class="${P}-hint">${time}</span> ${body}</div>`;
    }).join('');
}

function renderDanbooruSummary(summary, degraded) {
    const box = $id('danbooru-summary');
    if (!summary && !degraded) { box.innerHTML = ''; return; }
    let html = '';
    if (summary) {
        html += `✅ 단부루 검증 ${summary.verified.length}개`;
        if (summary.aliased.length) html += ` · 🔁 별칭 교정 ${summary.aliased.length}개`;
        if (summary.notFound.length) html += ` · ⚠️ 미등록(자연어 유지) ${summary.notFound.length}개`;
        if (summary.related.length) html += ` · ➕ 연관 제안 ${summary.related.length}건`;
    }
    if (degraded) html += `<div class="${P}-err">${esc(degraded)}</div>`;
    box.innerHTML = html;
}

// ===== 태그 저장소 =====

function libItemHTML(x) {
    const memo = x.memo ? `<div class="${P}-lib-memo">${esc(x.memo)}</div>` : '';
    return `<div class="${P}-lib-item" data-id="${esc(x.id)}">
        <div class="${P}-lib-head">
          <span class="${P}-badge ${P}-cat-${esc(x.category)}">${esc(categoryLabel(x.category))}</span>
          <span class="${P}-lib-title">${esc(x.title || '(제목 없음)')}</span>
        </div>
        <div class="${P}-lib-meta">${esc(fmtDate(x.updatedAt))}</div>
        ${memo}
        <div class="${P}-lib-content">${esc(x.content)}</div>
        <div class="${P}-row-flex">
          <button class="menu_button ${P}-mini" data-act="copy">복사</button>
          <button class="menu_button ${P}-mini" data-act="edit">편집</button>
          <button class="menu_button ${P}-mini" data-act="del">삭제</button>
        </div>
      </div>`;
}

function renderLibrary() {
    const counts = countByCategory(app.library);
    $id('lib-count').textContent = counts.all ? `(${counts.all})` : '';
    $id('lib-chips').innerHTML = [{ id: 'all', label: '전체' }, ...LIB_CATEGORIES]
        .map(c => `<button class="menu_button ${P}-chip ${lib.cat === c.id ? `${P}-chip-on` : ''}" data-cat="${c.id}">${esc(c.label)} ${counts[c.id] ?? 0}</button>`)
        .join('');

    if (!$id('lib-sec').open) return; // 목록은 펼쳤을 때만 그림 (저사양 기기 부하 방지)

    const items = filterItems(app.library, { category: lib.cat, query: lib.query });
    const shown = items.slice(0, lib.limit);
    $id('lib-list').innerHTML = shown.length
        ? shown.map(libItemHTML).join('')
        : `<small class="${P}-hint">${app.library.length ? '조건에 맞는 항목이 없습니다.' : '저장된 태그가 없습니다. 결과창의 💾 저장 또는 + 새 항목으로 추가하세요.'}</small>`;
    const more = $id('lib-more');
    const rest = items.length - shown.length;
    more.style.display = rest > 0 ? '' : 'none';
    more.textContent = `더 보기 (${rest}개 남음)`;
}

function openLibForm(prefill = {}) {
    lib.editingId = prefill.id || null;
    $id('lib-form-title').textContent = lib.editingId ? '항목 편집' : '새 항목';
    $id('lib-f-cat').value = prefill.category || 'character';
    $id('lib-f-title').value = prefill.title || '';
    $id('lib-f-content').value = prefill.content || '';
    $id('lib-f-memo').value = prefill.memo || '';
    const sec = $id('lib-sec');
    if (!sec.open) sec.open = true; // toggle 이벤트에서 목록 렌더
    const form = $id('lib-form');
    form.style.display = '';
    try { form.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) { /* ignore */ }
}

function closeLibForm() {
    lib.editingId = null;
    $id('lib-form').style.display = 'none';
}

async function saveLibForm() {
    const category = $id('lib-f-cat').value;
    const content = $id('lib-f-content').value.trim();
    let title = $id('lib-f-title').value.trim();
    const memo = $id('lib-f-memo').value.trim();
    if (!content) { toast('프롬프트 내용을 입력해주세요.', 'warning'); return; }
    if (content.length > LIB_LIMITS.content || title.length > LIB_LIMITS.title || memo.length > LIB_LIMITS.memo) {
        toast(`길이 한도 초과 — 제목 ${LIB_LIMITS.title}자 / 내용 ${LIB_LIMITS.content}자 / 메모 ${LIB_LIMITS.memo}자 이내`, 'warning');
        return;
    }
    const existing = lib.editingId ? app.library.find(x => x.id === lib.editingId) : null;
    if (!existing && app.library.length >= LIB_LIMITS.items) {
        toast(`저장 한도(${LIB_LIMITS.items}개)에 도달했습니다. 사용하지 않는 항목을 정리해주세요.`, 'warning');
        return;
    }
    const now = Date.now();
    if (!title) title = `${categoryLabel(category)} · ${fmtDate(now)}`;
    const item = normalizeItem({
        id: existing?.id, category, title, content, memo,
        createdAt: existing?.createdAt ?? now, updatedAt: now,
    }, now);
    if (!item) { toast('저장할 수 없는 항목입니다.', 'error'); return; }
    try {
        await saveLibrary(upsertItem(app.library, item));
        closeLibForm();
        renderLibrary();
        toast(existing ? '수정했습니다.' : '태그 저장소에 저장했습니다.', 'success');
    } catch (e) {
        toast(e.message, 'error');
    }
}

async function onLibListClick(ev) {
    const btn = ev.target.closest('button[data-act]');
    if (!btn) return;
    const id = btn.closest(`.${P}-lib-item`)?.dataset.id;
    const item = app.library.find(x => x.id === id);
    if (!item) return;
    const act = btn.dataset.act;
    if (act === 'copy') {
        copyText(item.content);
    } else if (act === 'edit') {
        openLibForm(item);
    } else if (act === 'del') {
        const ok = await confirmPopup(`<b>${esc(item.title || '(제목 없음)')}</b> 항목을 삭제할까요?`, '저장된 태그 삭제');
        if (!ok) return;
        try {
            await saveLibrary(removeItem(app.library, id));
            if (lib.editingId === id) closeLibForm();
            renderLibrary();
            toast('삭제했습니다.', 'success');
        } catch (e) {
            toast(e.message, 'error');
        }
    }
}

function guessTargetName() {
    return (S().target_name || '').trim() || stContext()?.name2 || '';
}

// ===== 복사 / 파일 =====

async function copyText(text) {
    if (!text) { toast('복사할 내용이 없습니다.', 'warning'); return; }
    try {
        await navigator.clipboard.writeText(text);
        toast('복사되었습니다.', 'success');
        return;
    } catch (e) { /* fallback */ }
    try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.focus(); ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        toast(ok ? '복사되었습니다.' : '복사 실패 — 결과창을 길게 눌러 수동 복사해주세요.', ok ? 'success' : 'warning');
    } catch (e) {
        toast('복사 실패 — 결과창을 길게 눌러 수동 복사해주세요.', 'warning');
    }
}

function downloadJSON(obj, filename) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

async function readJSONFile(input) {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return null;
    return JSON.parse(await file.text());
}

// ===== 이벤트 바인딩 =====

function bindEvents() {
    const on = (id, ev, fn) => $id(id).addEventListener(ev, fn);
    const bindVal = (id, key, isNum = false, after) => on(id, 'input', ev => {
        S()[key] = isNum ? Number(ev.target.value) : ev.target.value;
        saveSettings();
        if (after) after(ev.target.value);
    });
    const bindChk = (id, key, after) => on(id, 'change', ev => {
        S()[key] = ev.target.checked;
        saveSettings();
        if (after) after(ev.target.checked);
    });
    const sceneInfoLater = debounce(updateSceneInfo, 250);

    // 연결
    on('provider', 'change', ev => { S().provider = ev.target.value; saveSettings(); syncModelSelect(); });
    on('model', 'change', ev => { S().models[S().provider] = ev.target.value; saveSettings(); });
    on('use-custom-model', 'change', ev => { S().use_custom_model[S().provider] = ev.target.checked; saveSettings(); syncModelSelect(); });
    on('custom-model', 'input', ev => { S().custom_models[S().provider] = ev.target.value; saveSettings(); });
    bindChk('use-proxy', 'use_reverse_proxy', v => { $id('proxy-box').style.display = v ? '' : 'none'; });
    bindVal('proxy-url', 'reverse_proxy_url');
    bindVal('proxy-pw', 'reverse_proxy_password');
    bindVal('max-tokens', 'max_tokens', true);
    bindVal('temp', 'temperature', true);
    bindChk('prefill', 'prefill_enabled', v => { $id('prefill-content').style.display = v ? '' : 'none'; });
    bindVal('prefill-content', 'prefill_content');

    // 추출 설정
    bindVal('target', 'target_name');
    bindChk('src-char', 'src_char_profile');
    bindChk('src-persona', 'src_user_persona');
    bindChk('src-wi', 'src_worldinfo', v => { $id('wi-box').style.display = v ? '' : 'none'; });
    on('wi-load', 'click', async () => {
        $id('wi-list').innerHTML = `<small class="${P}-hint">불러오는 중...</small>`;
        try {
            const { charName, entries } = await loadWIForCurrentChar();
            renderWIList();
            toast(entries.length ? `${charName}: 엔트리 ${entries.length}개 로드` : '연결된 월드인포/로어북이 없습니다.', entries.length ? 'success' : 'warning');
        } catch (e) {
            $id('wi-list').innerHTML = `<small class="${P}-err">로드 실패: ${esc(e.message)}</small>`;
        }
    });
    on('wi-list', 'change', ev => {
        const cb = ev.target.closest('input[data-wi]');
        if (!cb) return;
        const e = app.wiEntries[Number(cb.dataset.wi)];
        if (!e) return;
        const k = entryKey(e);
        if (cb.checked) app.wiSelected.add(k); else app.wiSelected.delete(k);
        saveWISelection();
    });

    // 장면
    bindChk('scene', 'scene_mode', () => syncSceneBoxes());
    document.querySelectorAll(`input[name="${P}-scene-sel"]`).forEach(r => r.addEventListener('change', ev => {
        if (!ev.target.checked) return;
        S().scene_select_mode = ev.target.value === 'range' ? 'range' : 'recent';
        saveSettings();
        syncSceneBoxes();
    }));
    bindVal('scene-n', 'scene_msg_count', true, sceneInfoLater);
    bindVal('scene-start', 'scene_range_start', false, sceneInfoLater);
    bindVal('scene-end', 'scene_range_end', false, sceneInfoLater);
    on('scene-refresh', 'click', updateSceneInfo);
    on('extract-sec', 'toggle', () => { if ($id('extract-sec').open) updateSceneInfo(); });
    bindVal('scene-focus', 'scene_focus');

    // 프롬프트
    on('prompt-select', 'change', syncPromptEditor);
    on('prompt-editor', 'input', ev => {
        const key = $id('prompt-select').value;
        // 기본값과 정확히 같거나 비어 있으면 null(기본값 사용)로 저장
        S()[key] = normalizePromptValue(key, ev.target.value);
        saveSettings();
        updatePromptState(key);
    });
    on('prompt-reset', 'click', () => {
        const key = $id('prompt-select').value;
        S()[key] = null;
        syncPromptEditor();
        saveSettings();
        toast('기본값으로 복원했습니다.', 'info');
    });
    bindVal('detail', 'detail_instructions');

    // 단부루
    bindChk('danbooru', 'danbooru_enabled', v => { $id('danbooru-box').style.display = v ? '' : 'none'; });
    bindChk('danbooru-related', 'danbooru_related');
    on('danbooru-test', 'click', async () => {
        const out = $id('danbooru-test-result');
        out.textContent = '테스트 중...';
        const r = await testDanbooru();
        out.innerHTML = r.ok ? `✅ ${esc(r.msg)}` : `<span class="${P}-err">❌ ${esc(r.msg)}</span>`;
    });

    // 실행
    on('run', 'click', async () => {
        const btn = $id('run');
        const status = $id('status');
        if (app.running) return;
        btn.disabled = true;
        renderDanbooruSummary(null, '');
        try {
            const r = await runExtraction(msg => { status.textContent = msg; });
            $id('result').value = r.tags;
            renderDanbooruSummary(r.danbooru, r.degraded);
            status.textContent = '완료';
            renderHistory();
            $id('preview-p2').style.display = app.lastRun?.pass2Prompt ? '' : 'none';
        } catch (e) {
            status.textContent = '';
            toast(e.message, 'error');
        } finally {
            btn.disabled = false;
            renderLog();
        }
    });

    // 결과 복사 / 저장
    on('copy', 'click', () => copyText($id('result').value));
    on('save-result', 'click', () => {
        const content = $id('result').value.trim();
        if (!content) { toast('저장할 결과가 없습니다.', 'warning'); return; }
        openLibForm({ category: S().scene_mode ? 'scene' : 'character', title: guessTargetName(), content });
    });

    // 히스토리 (이벤트 위임)
    bindVal('hist-limit', 'history_limit', true);
    on('hist-list', 'click', async ev => {
        const btn = ev.target.closest('button[data-hact]');
        if (!btn) return;
        const i = Number(btn.dataset.i);
        const list = await getHistory();
        const h = list[i];
        if (!h) return;
        if (btn.dataset.hact === 'copy') copyText(h.tags);
        else if (btn.dataset.hact === 'save') openLibForm({ category: h.scene ? 'scene' : 'character', title: h.target || '', content: h.tags });
        else if (btn.dataset.hact === 'del') { await deleteHistoryAt(i); renderHistory(); }
    });

    // 태그 저장소
    on('lib-sec', 'toggle', () => { if ($id('lib-sec').open) renderLibrary(); });
    on('lib-new', 'click', () => openLibForm({}));
    on('lib-f-save', 'click', saveLibForm);
    on('lib-f-cancel', 'click', closeLibForm);
    on('lib-list', 'click', onLibListClick);
    on('lib-chips', 'click', ev => {
        const b = ev.target.closest('button[data-cat]');
        if (!b) return;
        lib.cat = b.dataset.cat;
        lib.limit = LIB_PAGE;
        renderLibrary();
    });
    const searchLater = debounce(v => { lib.query = v; lib.limit = LIB_PAGE; renderLibrary(); }, 200);
    on('lib-search', 'input', ev => searchLater(ev.target.value));
    on('lib-more', 'click', () => { lib.limit += LIB_PAGE; renderLibrary(); });
    on('lib-export', 'click', () => {
        if (!app.library.length) { toast('내보낼 태그가 없습니다.', 'warning'); return; }
        downloadJSON(buildLibraryExport(app.library), `nai-tagger-tags-${stamp()}.json`);
        toast(`${app.library.length}개 항목을 내보냈습니다.`, 'success');
    });
    on('lib-import', 'click', () => $id('lib-import-file').click());
    on('lib-import-file', 'change', async ev => {
        try {
            const data = await readJSONFile(ev.target);
            if (!data) return;
            const m = mergeImport(app.library, parseLibraryImport(data));
            await saveLibrary(m.list);
            renderLibrary();
            let msg = `추가 ${m.added} · 갱신 ${m.updated} · 중복 건너뜀 ${m.skipped}`;
            if (m.invalid) msg += ` · 형식 오류/한도 초과 ${m.invalid}`;
            if (m.overflow) msg += ` · 저장 한도로 제외 ${m.overflow}`;
            toast(msg, (m.invalid || m.overflow) ? 'warning' : 'success');
        } catch (e) {
            toast('불러오기 실패: ' + e.message, 'error');
        }
    });

    // 미리보기
    on('preview-btn', 'click', async () => {
        $id('preview-tokens').textContent = '조립 중...';
        try {
            const { prompt, tokens, approx } = await buildPreview();
            $id('preview').value = prompt;
            $id('preview-tokens').textContent = `예상 토큰: ${approx ? '약 ' : ''}${tokens}`;
        } catch (e) {
            $id('preview-tokens').textContent = '실패: ' + e.message;
        }
    });
    on('preview-p2', 'click', () => {
        if (app.lastRun?.pass2Prompt) $id('preview').value = app.lastRun.pass2Prompt;
    });

    // 데이터 관리
    on('export', 'click', async () => {
        downloadJSON(await buildFullBackup(), `nai-tagger-backup-${stamp()}.json`);
        toast('내보내기 완료 (프록시 비밀번호 포함 — 파일 관리에 주의)', 'info');
    });
    on('import', 'click', () => $id('import-file').click());
    on('import-file', 'change', async ev => {
        try {
            const data = await readJSONFile(ev.target);
            if (!data) return;
            if (data?.ext !== 'st-nai-tagger' || !data.settings) throw new Error('이 확장의 백업 파일이 아닙니다.');
            const ok = await confirmPopup('현재 <b>설정과 히스토리</b>가 백업 파일 내용으로 교체됩니다.<br>태그 저장소는 지워지지 않고 병합됩니다. 계속할까요?', '백업 가져오기');
            if (!ok) return;
            const r = await applyFullBackup(data);
            syncAll(); renderHistory(); renderLibrary();
            const libMsg = r.lib ? ` · 태그 저장소 추가 ${r.lib.added}, 갱신 ${r.lib.updated}` : '';
            toast(`가져오기 완료${libMsg}`, 'success');
        } catch (e) {
            toast('가져오기 실패: ' + e.message, 'error');
        }
    });
    on('wipe', 'click', async () => {
        const n = app.library.length;
        const libWarn = n ? `<br><b>태그 저장소의 ${n}개 항목도 함께 삭제됩니다.</b> 필요하면 먼저 태그 저장소에서 내보내기 하세요.` : '';
        const ok = await confirmPopup(`NAI 태그 추출기의 <b>모든 데이터</b>(설정, 히스토리, 태그 저장소, 단부루 캐시, 로그)를 삭제합니다.${libWarn}<br>ST 본체나 다른 확장에는 영향이 없습니다. 계속할까요?`, '모든 데이터 삭제');
        if (!ok) return;
        await wipeAll();
        closeLibForm();
        $id('result').value = '';
        $id('preview').value = '';
        syncAll(); renderWIList(); renderHistory(); renderLog(); renderLibrary();
        renderDanbooruSummary(null, '');
        toast('모든 데이터를 삭제했습니다.', 'success');
    });
}

// ===== 마운트 =====

export function mountUI() {
    const host = document.getElementById('extensions_settings2')
        || document.getElementById('extensions_settings');
    if (!host) throw new Error('확장 설정 패널을 찾을 수 없습니다.');
    const wrap = document.createElement('div');
    wrap.innerHTML = panelHTML();
    host.appendChild(wrap.firstElementChild);

    syncAll();
    bindEvents();
    renderWIList();
    renderHistory();
    renderLog();
    renderLibrary();
}
