/**
 * NAI Tag Extractor - 진입점
 * 채팅 정보 기반 NovelAI 이미지 생성 태그 추출 확장.
 * 저장: IndexedDB 전용 (ST settings.json 불가침) / 호출: fetch 직접 (프리셋 비의존)
 */

import { initST, ST, toast } from './src/stcore.js';
import { initStore } from './src/store.js';
import { loadAll } from './src/app.js';
import { mountUI } from './src/ui.js';

(async function init() {
    try {
        const ok = await initST();
        if (!ok) {
            console.error('[nai-tagger] ST 코어 모듈 로드 실패:', ST.missing);
        }
        const backend = await initStore();
        console.log(`[nai-tagger] storage backend: ${backend}`);

        await loadAll();
        mountUI();

        if (ST.missing.length) {
            console.warn('[nai-tagger] 일부 ST 모듈 미확보(해당 기능만 저하):', ST.missing);
        }
        console.log('[nai-tagger] loaded');
    } catch (e) {
        console.error('[nai-tagger] init failed:', e);
        try { toast('NAI 태그 추출기 초기화 실패: ' + e.message, 'error'); } catch (e2) { /* ignore */ }
    }
})();
