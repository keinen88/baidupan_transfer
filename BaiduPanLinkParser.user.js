// ==UserScript==
// @name         百度网盘链接提取与转存
// @version      2025.12.01
// @description  提取选中的链接并自动转存，支持 F4 快捷键手动输入（链接+提取码双框）和面板拖动。
// @license      MIT
// @match        *://*/*
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      dl1.20250823.xyz
// ==/UserScript==

(function() {
    'use strict';

    // ================= 配置 =================

    const API_BASE = "https://api.20250823.xyz";
    const HOTKEY = 'F4';

    // ================= 样式 (保持一致 + 新增输入框样式) =================
    const STYLES = `
        #bd-helper-panel {
            position: fixed; z-index: 9999999;
            background: #fff; border: 1px solid #ccc;
            box-shadow: 0 4px 12px rgba(0,0,0,0.2); border-radius: 6px;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
            font-size: 13px; color: #333; width: 450px;
            display: flex; flex-direction: column; overflow: hidden;
        }
        .p-head {
            background: #f5f5f5; padding: 10px 15px; font-weight: 600;
            border-bottom: 1px solid #ddd; display: flex; justify-content: space-between; align-items: center;
            /* 允许拖动 */
            cursor: move;
            user-select: none; /* 拖动时禁止文本选中 */
        }
        .p-close { cursor: pointer; font-size: 18px; color: #999; transition: color 0.2s; }
        .p-close:hover { color: #f5222d; }
        .p-body { max-height: 400px; overflow-y: auto; padding: 0; }
        .p-item { padding: 12px 15px; border-bottom: 1px solid #eee; }
        .p-item:hover { background: #fafafa; }
        .p-url { color: #1890ff; margin-bottom: 6px; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .p-meta { color: #666; font-size: 12px; margin-bottom: 8px; }
        .p-btn { cursor: pointer; background: #fff; border: 1px solid #d9d9d9; padding: 4px 12px; border-radius: 4px; font-size: 12px; }
        .p-btn-primary { background: #1890ff; border-color: #1890ff; color: #fff; }
        .p-btn-block { width: 100%; padding: 8px; margin-top: 10px; }
        /* 通用输入框样式 */
        .p-input { width: 100%; box-sizing: border-box; border: 1px solid #d9d9d9; border-radius: 4px; padding: 8px; font-family: inherit; font-size: 12px; margin-bottom: 10px;}
        .p-input:focus { border-color: #40a9ff; outline: 0; box-shadow: 0 0 0 2px rgba(24,144,255,0.2); }

        .p-foot { background: #f9f9f9; padding: 8px; text-align: center; border-top: 1px solid #eee; }

        .result-row { padding: 10px 15px; border-bottom: 1px solid #eee; display: flex; gap: 10px; align-items: center; }
        .loading-msg { padding: 30px 20px; text-align: center; color: #666; }
        .error-msg { color: #ff4d4f; padding: 20px; text-align: center; background: #fff1f0; border-bottom: 1px solid #ffa39e; }
        .cd-msg { font-size: 14px; font-weight: bold; color: #fa8c16; padding: 20px; text-align: center; background: #fff7e6; }
    `;
    const styleEl = document.createElement('style');
    styleEl.textContent = STYLES;
    document.body.appendChild(styleEl);

    // ================= 工具函数 =================
    function extractPanLinks(text) {
        const linkRegex = /(https?:\/\/pan\.baidu\.com\/s\/[A-Za-z0-9_-]{5,})/gi;
        const codeRegex = /\b([A-Za-z0-9]{4})\b/g;
        const links = [];
        let m;
        while ((m = linkRegex.exec(text)) !== null) links.push({url: m[1]});
        const codes = [];
        while ((m = codeRegex.exec(text)) !== null) codes.push(m[1]);

        let codeIndex = codes.length - 1;
        return links.reverse().map(l => {
            let code = null;
            if (!/[?&]pwd=/i.test(l.url)) {
                code = codes[codeIndex] || null;
                codeIndex = Math.max(codeIndex - 1, -1);
            }
            return {url: l.url, code};
        }).reverse();
    }

    function makeFullLink(url, code) {
        if (/[?&]pwd=/i.test(url) || !code) return url;
        return url + (url.includes('?') ? '&' : '?') + 'pwd=' + encodeURIComponent(code);
    }

    // ================= 核心：调用 API (逻辑不变) =================
    function callGoApi(fullUrl, container) {
        const bodyDiv = container.querySelector('.p-body');
        bodyDiv.innerHTML = `
            <div class="loading-msg">
                🚀 正在请求云端解析...<br>
                <span style="font-size:12px;color:#999">正在创建传输任务，请耐心等待</span>
            </div>
        `;

        GM_xmlhttpRequest({
            method: "POST",
            url: `${API_BASE}/api/parse`,
            headers: { "Content-Type": "application/json" },
            data: JSON.stringify({ url: fullUrl }),
            onload: (res) => {
                let json = {};
                try {
                    json = JSON.parse(res.responseText);
                } catch (e) {
                    return bodyDiv.innerHTML = `<div class="error-msg">解析响应失败，非 JSON 格式</div>`;
                }

                if (res.status === 429 || json.code === 429) {
                    const remaining = (json.data && json.data.remaining) ? json.data.remaining : 120;
                    showCooldown(bodyDiv, remaining, fullUrl, container);
                    return;
                }

                if (json.code === 200 && json.data && json.data.folder) {
                    renderResultList(json.data.folder, container);
                } else {
                    const errMsg = json.msg || "未知错误";
                    bodyDiv.innerHTML = `<div class="error-msg">❌ 解析失败: ${errMsg}</div>`;
                }
            },
            onerror: () => {
                bodyDiv.innerHTML = `<div class="error-msg">🚫 服务器连接失败<br>请检查网络或服务端状态</div>`;
            }
        });
    }

    // (showCooldown 和 renderResultList 保持不变)
    function showCooldown(bodyDiv, seconds, fullUrl, container) {
        let timeLeft = seconds;
        const updateUI = () => {
            bodyDiv.innerHTML = `
                <div class="cd-msg">
                    ⏳ 服务端队列排队中<br>
                    <span style="font-size:24px; display:block; margin:10px 0;">${timeLeft}s</span>
                    <span style="font-size:12px; font-weight:normal; color:#666">为保障服务稳定，请稍后重试</span>
                </div>
                <div style="padding:15px; text-align:center;">
                    <button id="btn-retry" class="p-btn p-btn-disabled" disabled>等待中...</button>
                </div>
            `;
        };
        updateUI();
        const timer = setInterval(() => {
            timeLeft--;
            if (timeLeft <= 0) {
                clearInterval(timer);
                bodyDiv.innerHTML = `
                    <div class="cd-msg" style="color:#52c41a; background:#f6ffed;">
                        ✅ 排队结束<br>您可以重新尝试了
                    </div>
                    <div style="padding:15px; text-align:center;">
                        <button id="btn-retry-now" class="p-btn p-btn-primary p-btn-block">立即重试</button>
                    </div>
                `;
                const btn = bodyDiv.querySelector('#btn-retry-now');
                if(btn) btn.onclick = () => callGoApi(fullUrl, container);
            } else {
                updateUI();
            }
        }, 1000);
    }

    function renderResultList(files, container) {
        const body = container.querySelector('.p-body');
        const foot = container.querySelector('.p-foot');
        let html = `<div style="padding:10px; color:#52c41a; font-weight:bold; border-bottom:1px solid #eee; background:#f6ffed;">✅ 解析成功 (${files.length}个)</div>`;

        files.forEach(file => {
            html += `
                <div class="result-row">
                    <div style="flex:1; overflow:hidden;">
                        <div style="font-weight:500; font-size:13px;">${file.name}</div>
                        <a href="${file.download_url}" target="_blank" class="result-link" style="color:#999; font-size:11px;">点击下载</a>
                    </div>
                    <button class="p-btn" onclick="navigator.clipboard.writeText('${file.download_url}');this.innerText='已复制'">复制</button>
                </div>
            `;
        });
        body.innerHTML = html;
        foot.innerHTML = `<button class="p-btn p-btn-primary p-btn-block" id="copy-all">复制全部链接</button>`;
        container.querySelector('#copy-all').onclick = () => {
            GM_setClipboard(files.map(f => f.download_url).join('\n'));
            alert('已复制全部');
        };
    }

    // ================= 手动输入界面 (双框) =================
    function renderManualInput(container) {
        const body = container.querySelector('.p-body');
        const foot = container.querySelector('.p-foot');

        body.innerHTML = `
            <div style="padding: 15px;">
                <div style="margin-bottom:8px; font-weight:500;">网盘分享链接 (URL)</div>
                <input type="text" class="p-input" id="manual-url" placeholder="例如：https://pan.baidu.com/s/xxxxxx">

                <div style="margin-bottom:8px; font-weight:500;">提取码 (4位)</div>
                <input type="text" class="p-input" id="manual-code" placeholder="例如：1234">

                <div style="margin-top:0px; color:#999; font-size:12px;">注：如果链接中已包含密码，可不填提取码。</div>
            </div>
        `;

        foot.innerHTML = `<button class="p-btn p-btn-primary p-btn-block" id="manual-submit">开始解析</button>`;

        const urlInput = container.querySelector('#manual-url');
        const codeInput = container.querySelector('#manual-code');

        setTimeout(() => { if(urlInput) urlInput.focus(); }, 100);

        container.querySelector('#manual-submit').onclick = () => {
            const url = urlInput.value.trim();
            let code = codeInput.value.trim();

            if (!url) return alert("请输入网盘链接");

            if (!url.startsWith('http') || !/pan\.baidu\.com/i.test(url)) {
                return alert("链接格式不正确，请确保是 pan.baidu.com 的链接");
            }

            if (/[?&]pwd=/i.test(url)) {
                code = null;
            } else if (code.length !== 4 && code.length !== 0) {
                 return alert("提取码通常是4位数字或字母组合");
            }

            const items = [{ url: url, code: code || null }];

            renderLinkList(container, items);
        };
    }

    // ================= 主入口 =================
    let panelContainer = null;
    let lastMouseX = 0, lastMouseY = 0;

    function renderLinkList(container, items) {
        const body = container.querySelector('.p-body');
        let html = '';
        items.forEach((it, i) => {
            html += `
                <div class="p-item">
                    <div class="p-url">${it.url}</div>
                    <div class="p-meta">${it.code ? `提取码: ${it.code}` : '<span style="color:#ff4d4f">无提取码</span>'}</div>
                    <button class="p-btn p-btn-primary p-btn-block" id="btn-run-${i}">极速解析</button>
                </div>
            `;
        });
        body.innerHTML = html;
        items.forEach((it, i) => {
            container.querySelector(`#btn-run-${i}`).onclick = () => callGoApi(makeFullLink(it.url, it.code), container);
        });

        const foot = container.querySelector('.p-foot');
        if (items.length === 1 && foot.innerHTML.indexOf('copy-all') === -1) {
            foot.innerHTML = `<button class="p-btn p-btn-block" id="manual-reset" style="margin: 0; background:#f0f0f0;">返回手动输入</button>`;
            container.querySelector('#manual-reset').onclick = () => renderManualInput(container);
        }
    }

    function showPanel(items, x, y, isManual = false) {
        if(panelContainer) panelContainer.remove();
        const container = document.createElement('div');
        container.id = 'bd-helper-panel';

        if(x + 450 > window.innerWidth) x = window.innerWidth - 470;
        if(y + 400 > window.innerHeight) y = window.innerHeight - 420;

        container.style.top = y + 'px';
        container.style.left = x + 'px';

        container.innerHTML = `<div class="p-head"><span>网盘直链提取助手 ${isManual ? '(手动模式)' : ''}</span><span class="p-close">×</span></div><div class="p-body"></div><div class="p-foot"></div>`;

        document.body.appendChild(container);
        panelContainer = container;
        container.querySelector('.p-close').onclick = () => { container.remove(); panelContainer = null; };

        // ======================== 拖动功能实现 ========================
        const header = container.querySelector('.p-head');
        let isDragging = false;
        let startX, startY, startLeft, startTop;

        header.onmousedown = (e) => {
            // 确保只处理左键点击
            if (e.button !== 0) return;

            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;
            startLeft = container.offsetLeft;
            startTop = container.offsetTop;

            // 拖动过程中更改鼠标样式
            header.style.cursor = 'grabbing';

            document.onmousemove = (e) => {
                if (!isDragging) return;
                const dx = e.clientX - startX;
                const dy = e.clientY - startY;

                container.style.left = (startLeft + dx) + 'px';
                container.style.top = (startTop + dy) + 'px';
            };

            document.onmouseup = () => {
                if (isDragging) {
                    isDragging = false;
                    header.style.cursor = 'move'; // 拖动结束后恢复
                    document.onmousemove = null;
                    document.onmouseup = null;
                }
            };
            // 阻止默认文本选择行为
            e.preventDefault();
        };
        // ======================== 拖动功能结束 ========================

        if (isManual || items.length === 0) {
            renderManualInput(container);
        } else {
            renderLinkList(container, items);
        }
    }

    // 鼠标坐标记录 (用于 'copy' 触发)
    document.addEventListener('mouseup', e => { lastMouseX = e.clientX; lastMouseY = e.clientY; });

    // 自动复制监听
    document.addEventListener('copy', () => {
        setTimeout(() => {
            const text = window.getSelection().toString();
            if(text && text.length > 10) {
                const items = extractPanLinks(text);
                if(items.length) showPanel(items, lastMouseX + 20, lastMouseY + 20);
            }
        }, 100);
    });

    // 快捷键监听 (默认 F4)
    document.addEventListener('keydown', (e) => {
        if (e.key === HOTKEY && !e.altKey && !e.ctrlKey && !e.shiftKey) {
            e.preventDefault();
            const x = (window.innerWidth - 450) / 2;
            const y = (window.innerHeight - 300) / 2;
            showPanel([], x, y, true);
        }
    });

})();
