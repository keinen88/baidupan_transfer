// ==UserScript==
// @name         百度网盘链接提取与转存
// @version      2025.11.30
// @description  提取选中的百度网盘链接，自动弹出面板，转存成功后需手动点击跳转
// @license      MIT
// @match        *://*/*
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @connect      gist.githubusercontent.com
// @connect      dl.20250823.xyz
// @connect      dl1.20250823.xyz
// @connect      dl2.20250823.xyz
// ==/UserScript==

(function(){
    'use strict';

    // ================= 配置区域 =================

    // 1. 【内置默认列表】 (当远程获取失败时使用此列表兜底)
    const DEFAULT_APIS = [
        "https://dl.20250823.xyz",
        "https://dl1.20250823.xyz",
        "https://dl2.20250823.xyz"
    ];

    // 2. 【远程配置地址】 (脚本启动时会自动从此地址更新 API 列表)
    const REMOTE_CONFIG_URL = "https://gist.githubusercontent.com/keinen88/cdab96f5b393eea716453910371fb399/raw/86eb606e09e68ca0083235160088559bf01dd11d/remote_config_url.json";

    // ===========================================


    let activeApiList = [...DEFAULT_APIS]; // 当前正在使用的列表
    let lastMouseX = 0;
    let lastMouseY = 0;
    let panelContainer = null;

    // --- 远程配置获取逻辑 ---
    function fetchRemoteConfig() {
        if (!REMOTE_CONFIG_URL) return;

        GM_xmlhttpRequest({
            method: "GET",
            url: REMOTE_CONFIG_URL,
            onload: function(response) {
                try {
                    if (response.status === 200) {
                        const remoteList = JSON.parse(response.responseText);
                        if (Array.isArray(remoteList) && remoteList.length > 0) {
                            activeApiList = remoteList;
                            console.log("云端 API 更新成功，加载节点数:", activeApiList.length);
                        }
                    }
                } catch (e) {
                    console.warn("远程配置解析失败，维持默认列表。", e);
                }
            },
            onerror: function(err) {
                console.warn("远程配置请求失败，维持默认列表。", err);
            }
        });
    }

    fetchRemoteConfig();

    // --- 极简 Toast 提示 ---
    function showToast(message, duration = 2000) {
        const existing = document.getElementById('pan-simple-toast');
        if (existing) existing.remove();

        const toast = document.createElement('div');
        toast.id = 'pan-simple-toast';
        toast.textContent = message;
        toast.style.cssText = `
            position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
            background: #333; color: #fff; padding: 8px 15px; font-size: 13px;
            border-radius: 4px; z-index: 99999999; font-family: sans-serif;
            box-shadow: 0 2px 5px rgba(0,0,0,0.3); pointer-events: none;
        `;
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), duration);
    }

    // --- 逻辑辅助函数 ---
    function selectNextApiBase(pool) {
        if (!pool || pool.length === 0) return null;
        return pool.splice(Math.floor(Math.random() * pool.length), 1)[0];
    }

    function extractPanLinks(text) {
        const linkRegex = /(https?:\/\/pan\.baidu\.com\/s\/[A-Za-z0-9_-]{5,})/gi;
        const codeRegex = /\b([A-Za-z0-9]{4})\b/g;
        const unzipRegex = /(?:[密码]|pwd|code)\W*([A-Za-z0-9]{4,10})/gi;

        const links = [];
        let m;
        while ((m = linkRegex.exec(text)) !== null) links.push({url: m[1]});

        const codes = [];
        while ((m = codeRegex.exec(text)) !== null) codes.push(m[1]);

        const unzips = [];
        unzipRegex.lastIndex = 0;
        while ((m = unzipRegex.exec(text)) !== null) if(!unzips.includes(m[1])) unzips.push(m[1]);

        let codeIndex = codes.length - 1;
        let unzipIndex = unzips.length - 1;

        return links.reverse().map(l => {
            let code = null, unzip = null;
            if (!/[?&]pwd=/i.test(l.url)) {
                code = codes[codeIndex] || null;
                codeIndex = Math.max(codeIndex - 1, -1);
            }
            if (unzips.length > 0) {
                unzip = unzips[unzipIndex] || null;
                if(unzip === code) unzip = null;
                unzipIndex = Math.max(unzipIndex - 1, -1);
            }
            return {url: l.url, code, unzip};
        }).reverse();
    }

    function makeFullLink(url, code) {
        if (/[?&]pwd=/i.test(url) || !code) return url;
        return url + (url.includes('?') ? '&' : '?') + 'pwd=' + encodeURIComponent(code);
    }

    function gmPost(url, data, onload, onerror) {
        GM_xmlhttpRequest({
            method: "POST", url,
            headers: { "Content-Type": "application/json;charset=UTF-8" },
            data: JSON.stringify(data), responseType: "json", onload, onerror
        });
    }

    // --- 核心转存逻辑 (已修改：移除自动跳转，改为手动点击) ---
    function handleTransfer(item, btn, errorDiv, container, closeFunc) {
        const full = makeFullLink(item.url, item.code);

        const API_POOL = [...activeApiList];
        const initialApi = selectNextApiBase(API_POOL);

        if (!initialApi) return showToast("暂无可用 API");

        btn.disabled = true;
        btn.textContent = "处理中...";

        const folder = "/" + new Date().toISOString().replace(/[:.]/g,'-') + (item.code ? "_" + item.code : "");

        // 修改点 1: finish 函数接收 targetUrl 参数
        const finish = (success, msg, targetUrl) => {
            if (success) {
                btn.textContent = "打开"; // 修改点 2: 按钮文字改为“打开”
                btn.disabled = false;     // 修改点 3: 重新启用按钮
                btn.style.fontWeight = "bold";
                btn.style.color = "#008000"; // 绿色文字提示成功

                // 修改点 4: 覆盖按钮点击事件，改为打开新窗口
                btn.onclick = () => window.open(targetUrl, "_blank");

                showToast("转存成功，请点击“打开”");
                // 修改点 5: 移除自动关闭面板的代码，以便用户点击
                // setTimeout(() => closeFunc(container), 1500); 
            } else {
                btn.textContent = "重试";
                btn.disabled = false;
                errorDiv.textContent = msg;
                errorDiv.style.display = 'block';
            }
        };

        const tryReq = (retries, api, pool) => {
            const fail = (reason) => {
                if (retries > 1 && pool.length > 0) {
                    const next = selectNextApiBase(pool);
                    showToast("切换线路重试...");
                    setTimeout(() => tryReq(retries - 1, next, pool), 1000);
                } else finish(false, reason);
            };

            gmPost(`${api}/api/fs/mkdir`, { path: folder }, (r1) => {
                if (r1.response && r1.response.code === 200) {
                    gmPost(`${api}/api/fs/other`, {
                        path: folder, method: "transfer_file",
                        data: { path: "/百度网盘/分享/" + folder, url: full }
                    }, (r2) => {
                        if (r2.response?.code === 200 && r2.response?.data?.errno === 0) {
                            // 修改点 6: 成功后不直接 open，而是传入 url 给 finish 处理
                            finish(true, null, api + folder);
                        } else fail(r2.response?.message || "转存失败(API错误)");
                    }, () => fail("网络中断"));
                } else fail(r1.response?.message || "创建文件夹失败");
            }, () => fail("网络中断"));
        };
        tryReq(API_POOL.length + 1, initialApi, API_POOL);
    }

    // --- UI 渲染 ---
    function renderAuto(container, items) {
        let html = `<div class="p-head">检测到链接 (${items.length}) <span class="p-close">×</span></div>`;
        html += `<div class="p-body">`;

        items.forEach((it, i) => {
            html += `
                <div class="p-item">
                    <div class="p-url">${it.url}</div>
                    <div class="p-meta">码: <b>${it.code || '无'}</b> ${it.unzip ? `| 解: ${it.unzip}` : ''}</div>
                    <div class="p-actions">
                        <button id="c-${i}">复制</button>
                        <button id="t-${i}">转存</button>
                    </div>
                    <div id="e-${i}" class="p-error"></div>
                </div>
            `;
        });
        html += `</div><div class="p-foot"><button id="to-manual">识别有误？手动输入</button></div>`;
        container.innerHTML = html;

        container.querySelector('.p-close').onclick = () => container.remove();
        container.querySelector('#to-manual').onclick = () => renderManual(container);

        items.forEach((it, i) => {
            container.querySelector(`#c-${i}`).onclick = function() {
                GM_setClipboard(makeFullLink(it.url, it.code));
                this.textContent = "已复制";
                setTimeout(() => this.textContent = "复制", 1000);
            };
            container.querySelector(`#t-${i}`).onclick = function() {
                handleTransfer(it, this, container.querySelector(`#e-${i}`), container, () => container.remove());
            };
        });
    }

    function renderManual(container) {
        container.innerHTML = `
            <div class="p-head">手动输入 <span class="p-close">×</span></div>
            <div class="p-body" style="padding:10px;">
                <input type="text" id="m-url" placeholder="https://pan.baidu.com/s/..." class="p-input">
                <input type="text" id="m-code" placeholder="提取码 (4位)" class="p-input" maxlength="4">
                <button id="m-go" class="p-btn-block">开始转存</button>
                <div id="m-err" class="p-error"></div>
            </div>
            <div class="p-foot"><button id="to-auto">返回列表</button></div>
        `;

        container.querySelector('.p-close').onclick = () => container.remove();
        container.querySelector('#to-auto').onclick = () => {
             if(container._oldItems) renderAuto(container, container._oldItems);
             else container.remove();
        };

        const btn = container.querySelector('#m-go');
        btn.onclick = () => {
            const url = container.querySelector('#m-url').value.trim();
            const code = container.querySelector('#m-code').value.trim();
            const err = container.querySelector('#m-err');
            err.style.display = 'none';

            if(!url.includes('baidu.com/s/')) return err.textContent = "链接无效", err.style.display = 'block';

            handleTransfer({url, code}, btn, err, container, () => container.remove());
        };
    }

    // --- 主入口 ---
    function showPanel(items, x, y) {
        document.getElementById('pan-simple-panel')?.remove();
        if(!items.length) return;

        const container = document.createElement('div');
        container.id = 'pan-simple-panel';
        container._oldItems = items;

        const w = 380;
        if(x + w > window.innerWidth) x = window.innerWidth - w - 20;

        container.style.cssText = `
            position: fixed; top: ${y}px; left: ${x}px; width: ${w}px;
            background: #fff; border: 1px solid #ccc; box-shadow: 2px 3px 10px rgba(0,0,0,0.2);
            font-family: sans-serif; font-size: 13px; color: #333; z-index: 9999999;
        `;

        const style = document.createElement('style');
        style.textContent = `
            #pan-simple-panel * { box-sizing: border-box; margin: 0; padding: 0; }
            .p-head { background: #f0f0f0; padding: 8px 10px; font-weight: bold; border-bottom: 1px solid #ddd; display: flex; justify-content: space-between; }
            .p-close { cursor: pointer; font-size: 16px; }
            .p-body { max-height: 360px; overflow-y: auto; }
            .p-item { padding: 10px; border-bottom: 1px solid #eee; }
            .p-url { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: #666; margin-bottom: 5px; font-size: 12px; }
            .p-meta { margin-bottom: 8px; }
            .p-actions button, .p-foot button, .p-btn-block {
                cursor: pointer; background: #fff; border: 1px solid #999; padding: 4px 10px; border-radius: 2px; font-size: 12px;
            }
            .p-actions button:hover { background: #eee; }
            .p-actions button { margin-right: 5px; }
            .p-foot { background: #f9f9f9; padding: 8px; text-align: center; border-top: 1px solid #eee; }
            .p-foot button { border: none; background: none; color: #0066cc; text-decoration: underline; }
            .p-input { width: 100%; padding: 5px; margin-bottom: 8px; border: 1px solid #ccc; }
            .p-btn-block { width: 100%; background: #eee; padding: 6px; }
            .p-error { color: red; font-size: 12px; margin-top: 5px; display: none; }

            @media (prefers-color-scheme: dark) {
                #pan-simple-panel { background: #222 !important; color: #eee !important; border-color: #444 !important; }
                .p-head, .p-foot { background: #333 !important; border-color: #444 !important; }
                .p-item { border-color: #444 !important; }
                .p-url { color: #aaa !important; }
                .p-actions button, .p-input, .p-btn-block { background: #444 !important; border-color: #666 !important; color: #eee !important; }
                .p-actions button:hover { background: #555 !important; }
            }
        `;
        container.appendChild(style);
        document.body.appendChild(container);

        renderAuto(container, items);
        panelContainer = container;
    }

    // --- 事件监听 ---
    document.addEventListener('mouseup', e => { lastMouseX = e.clientX; lastMouseY = e.clientY; });

    document.addEventListener('copy', () => {
        try {
            const text = window.getSelection().toString();
            if(!text.trim()) return;
            const items = extractPanLinks(text);
            if(items.length) showPanel(items, lastMouseX + 10, lastMouseY + 10);
        } catch(e) {}
    });

    document.addEventListener('mousedown', e => {
        if(panelContainer && !panelContainer.contains(e.target)) {
            panelContainer.remove();
            panelContainer = null;
        }
    });

})();
