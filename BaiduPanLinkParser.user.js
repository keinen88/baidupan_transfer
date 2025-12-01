// ==UserScript==
// @name         百度网盘链接提取与转存
// @version      2025.12.01
// @description  提取选中的链接并自动转存。
// @license      MIT
// @match        *://*/*
// @match        https://dl1.20250823.xyz/*
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      gist.githubusercontent.com
// @connect      dl1.20250823.xyz
// @connect      api.telegram.org
// ==/UserScript==

(function(){
    'use strict';

    const CONFIG_URL = "https://gist.githubusercontent.com/keinen88/cdab96f5b393eea716453910371fb399/raw/remote_config_url.json";
    const SVC_DOMAIN = "dl1.20250823.xyz";
    const API_BASE = "https://" + SVC_DOMAIN;
    const REPORT_COOLDOWN = 3600000; // 1 Hour

    // --- Service Health Check (Running on download page) ---
    if (location.hostname === SVC_DOMAIN) {
        monitorService();
        return;
    }

    // --- Main Logic ---

    let currentApi = API_BASE;
    let isAvailable = true;
    let statusMsg = "Loading...";
    let isConfigReady = false;
    let panelRef = null;
    let mx = 0, my = 0;

    function syncConfig() {
        // Check local lockout first
        if (GM_getValue('svc_lock', false)) {
            isConfigReady = true;
            updateState("服务维护中 (Error 500)", true);
        }

        const t = Date.now();
        GM_xmlhttpRequest({
            method: "GET", url: CONFIG_URL + '?t=' + t, timeout: 5000,
            onload: function(res) {
                try {
                    if (res.status === 200) {
                        const cfg = JSON.parse(res.responseText);
                        if (cfg.target_api) currentApi = cfg.target_api;

                        // Check reset token
                        const lastToken = GM_getValue('svc_token', '');
                        if (cfg.reset_key && cfg.reset_key !== lastToken) {
                            GM_setValue('svc_lock', false);
                            GM_setValue('svc_token', cfg.reset_key);
                        }

                        const locked = GM_getValue('svc_lock', false);
                        if (locked) {
                            updateState("服务维护中 (等待恢复)", true);
                        } else if (cfg.enable === false) {
                            updateState(cfg.message || "服务暂停", false);
                        } else {
                            isAvailable = true;
                            statusMsg = "✅ 服务正常";
                            refreshUI();
                        }
                    } else {
                        statusMsg = "⚠️ 离线模式";
                    }
                } catch (e) {}
                finally {
                    isConfigReady = true;
                    refreshUI();
                }
            },
            onerror: () => { isConfigReady = true; statusMsg = "⚠️ 网络错误"; refreshUI(); }
        });
    }

    syncConfig();

    function monitorService() {
        const title = document.title;
        const body = document.body.innerText;
        // Detect specific server errors
        const isCritical = title.includes("500 Internal Server Error") ||
                           body.includes("cannot unmarshal number");

        if (isCritical) {
            GM_setValue('svc_lock', true);

            document.body.innerHTML = `
                <div style="padding:50px;text-align:center;font-family:sans-serif;">
                    <h1 style="color:#d32f2f;">服务暂时不可用</h1>
                    <p>系统已自动捕获异常并上报，请稍后重试。</p>
                </div>
            `;

            const lastReport = GM_getValue('rpt_time', 0);
            const now = Date.now();

            if (now - lastReport > REPORT_COOLDOWN) {
                GM_xmlhttpRequest({
                    method: "GET", url: CONFIG_URL + '?t=' + now,
                    onload: function(r) {
                        try {
                            const c = JSON.parse(r.responseText);
                            if (c.report_url) {
                                GM_xmlhttpRequest({
                                    method: "GET", url: c.report_url,
                                    onload: () => GM_setValue('rpt_time', now)
                                });
                            }
                        } catch(e) {}
                    }
                });
            }
        }
    }

    function updateState(msg, isErr) {
        isAvailable = false;
        statusMsg = (isErr ? "⛔ " : "🔒 ") + msg;
        refreshUI();
        if (panelRef) {
            const btns = panelRef.querySelectorAll('.p-actions button:last-child, #m-go');
            btns.forEach(b => {
                b.disabled = true;
                b.textContent = "已暂停";
                b.style.background = "#eee";
                b.style.color = "#999";
                b.onclick = null;
            });
        }
    }

    function refreshUI() {
        const bar = document.getElementById('pan-status-bar');
        if (bar) {
            bar.textContent = statusMsg;
            bar.style.backgroundColor = isAvailable ? '#e8f5e9' : '#ffebee';
            bar.style.color = isAvailable ? '#2e7d32' : '#c62828';
        }
    }

    function toast(msg) {
        const old = document.getElementById('pan-toast');
        if (old) old.remove();
        const t = document.createElement('div');
        t.id = 'pan-toast';
        t.textContent = msg;
        t.style.cssText = `position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); background: #333; color: #fff; padding: 8px 15px; font-size: 13px; border-radius: 4px; z-index: 99999999; pointer-events: none;`;
        document.body.appendChild(t);
        setTimeout(() => t.remove(), 2500);
    }

    function makeLink(url, code) {
        if (/[?&]pwd=/i.test(url) || !code) return url;
        return url + (url.includes('?') ? '&' : '?') + 'pwd=' + encodeURIComponent(code);
    }

    function apiReq(url, data, ok, fail) {
        GM_xmlhttpRequest({
            method: "POST", url,
            headers: { "Content-Type": "application/json;charset=UTF-8" },
            data: JSON.stringify(data), responseType: "json", onload: ok, onerror: fail
        });
    }

    function processLink(item, btn, errBox) {
        if (!isConfigReady) return toast("配置加载中...");
        if (GM_getValue('svc_lock', false)) {
            updateState("服务维护中", true);
            return;
        }
        if (!isAvailable) return;

        const fullUrl = makeLink(item.url, item.code);
        const path = "/" + new Date().toISOString().replace(/[:.]/g,'-') + (item.code ? "_" + item.code : "");

        btn.disabled = true;
        btn.textContent = "处理中...";
        errBox.style.display = 'none';

        const onFail = (msg) => {
            btn.textContent = "重试";
            btn.disabled = false;
            errBox.textContent = msg;
            errBox.style.display = 'block';
        };

        apiReq(`${currentApi}/api/fs/mkdir`, { path }, (r1) => {
            if (r1.response && r1.response.code === 200) {
                apiReq(`${currentApi}/api/fs/other`, {
                    path, method: "transfer_file",
                    data: { path: "/百度网盘/分享/" + path, url: fullUrl }
                }, (r2) => {
                    if (r2.response?.code === 200 && r2.response?.data?.errno === 0) {
                        const target = currentApi + path;
                        btn.textContent = "打开";
                        btn.disabled = false;
                        btn.style.fontWeight = "bold";
                        btn.style.color = "#008000";
                        btn.onclick = () => window.open(target, "_blank");
                        toast("转存成功");
                    } else {
                        onFail(r2.response?.message || "API Error");
                    }
                }, () => onFail("Network Error"));
            } else {
                onFail(r1.response?.message || "Mkdir Failed");
            }
        }, () => onFail("Network Error"));
    }

    function renderPanel(container, items) {
        let h = `<div class="p-head">检测到链接 (${items.length}) <span class="p-close">×</span></div>`;
        h += `<div id="pan-status-bar" style="background:#f5f5f5;padding:5px;font-size:12px;text-align:center;">${statusMsg}</div>`;
        h += `<div class="p-body">`;
        items.forEach((it, i) => {
            h += `<div class="p-item"><div class="p-url">${it.url}</div><div class="p-meta">码: <b>${it.code||'无'}</b></div><div class="p-actions"><button id="c-${i}">复制</button><button id="t-${i}" ${!isAvailable?'disabled':''}>转存</button></div><div id="e-${i}" class="p-error"></div></div>`;
        });
        h += `</div><div class="p-foot"><button id="to-manual">手动输入</button></div>`;
        container.innerHTML = h;
        refreshUI();

        container.querySelector('.p-close').onclick = () => container.remove();
        container.querySelector('#to-manual').onclick = () => renderManual(container);
        items.forEach((it, i) => {
            container.querySelector(`#c-${i}`).onclick = function() { GM_setClipboard(makeLink(it.url, it.code)); this.textContent="已复制"; setTimeout(()=>this.textContent="复制",1000); };
            container.querySelector(`#t-${i}`).onclick = function() { processLink(it, this, container.querySelector(`#e-${i}`)); };
        });
    }

    function renderManual(container) {
        container.innerHTML = `<div class="p-head">手动输入 <span class="p-close">×</span></div><div class="p-body" style="padding:10px;"><input type="text" id="m-url" placeholder="链接" class="p-input"><input type="text" id="m-code" placeholder="提取码" class="p-input" maxlength="4"><button id="m-go" class="p-btn-block" ${!isAvailable?'disabled':''}>${isAvailable?'开始转存':'暂停服务'}</button><div id="m-err" class="p-error"></div></div><div class="p-foot"><button id="to-auto">返回列表</button></div>`;
        container.querySelector('.p-close').onclick = () => container.remove();
        container.querySelector('#to-auto').onclick = () => { if(container._oldItems) renderPanel(container, container._oldItems); else container.remove(); };
        const btn = container.querySelector('#m-go');
        btn.onclick = () => {
            if(!isAvailable) return;
            const url = container.querySelector('#m-url').value.trim();
            const code = container.querySelector('#m-code').value.trim();
            const err = container.querySelector('#m-err'); err.style.display = 'none';
            if(!url.includes('baidu.com/s/')) return err.textContent = "无效链接", err.style.display = 'block';
            processLink({url, code}, btn, err);
        };
    }

    function showUI(items, x, y) {
        document.getElementById('pan-panel')?.remove();
        if(!items.length) return;
        const c = document.createElement('div');
        c.id = 'pan-panel'; c._oldItems = items;
        const w = 380; if(x + w > window.innerWidth) x = window.innerWidth - w - 20;
        c.style.cssText = `position: fixed; top: ${y}px; left: ${x}px; width: ${w}px; background: #fff; border: 1px solid #ccc; box-shadow: 2px 3px 10px rgba(0,0,0,0.2); font-family: sans-serif; font-size: 13px; color: #333; z-index: 9999999;`;
        const s = document.createElement('style');
        s.textContent = `#pan-panel *{box-sizing:border-box;margin:0;padding:0}.p-head{background:#f0f0f0;padding:8px 10px;font-weight:bold;border-bottom:1px solid #ddd;display:flex;justify-content:space-between}.p-close{cursor:pointer;font-size:16px}.p-body{max-height:360px;overflow-y:auto}.p-item{padding:10px;border-bottom:1px solid #eee}.p-url{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#666;margin-bottom:5px;font-size:12px}.p-meta{margin-bottom:8px}.p-actions button,.p-foot button,.p-btn-block{cursor:pointer;background:#fff;border:1px solid #999;padding:4px 10px;border-radius:2px;font-size:12px}.p-actions button:hover{background:#eee}.p-actions button{margin-right:5px}.p-foot{background:#f9f9f9;padding:8px;text-align:center;border-top:1px solid #eee}.p-foot button{border:none;background:none;color:#0066cc;text-decoration:underline}.p-input{width:100%;padding:5px;margin-bottom:8px;border:1px solid #ccc}.p-btn-block{width:100%;background:#eee;padding:6px}.p-error{color:red;font-size:12px;margin-top:5px;display:none}@media(prefers-color-scheme:dark){#pan-panel{background:#222!important;color:#eee!important;border-color:#444!important}.p-head,.p-foot{background:#333!important;border-color:#444!important}.p-item{border-color:#444!important}.p-url{color:#aaa!important}.p-actions button,.p-input,.p-btn-block{background:#444!important;border-color:#666!important;color:#eee!important}.p-actions button:hover{background:#555!important}}`;
        c.appendChild(s); document.body.appendChild(c);
        renderPanel(c, items); panelRef = c;
    }

    function parseText(txt) {
        const reLink = /(https?:\/\/pan\.baidu\.com\/s\/[A-Za-z0-9_-]{5,})/gi;
        const reCode = /\b([A-Za-z0-9]{4})\b/g;
        const links = []; let m; while ((m = reLink.exec(txt)) !== null) links.push({url: m[1]});
        const codes = []; while ((m = reCode.exec(txt)) !== null) codes.push(m[1]);
        let idx = codes.length - 1;
        return links.reverse().map(l => { let c = !/[?&]pwd=/i.test(l.url) ? (codes[idx--] || null) : null; return {url: l.url, code: c}; }).reverse();
    }

    document.addEventListener('mouseup', e => { mx = e.clientX; my = e.clientY; });
    document.addEventListener('copy', () => { try { const t = window.getSelection().toString(); if(t.trim()) { const i = parseText(t); if(i.length) showUI(i, mx + 10, my + 10); } } catch(e) {} });
    document.addEventListener('mousedown', e => { if(panelRef && !panelRef.contains(e.target)) { panelRef.remove(); panelRef = null; } });
})();
