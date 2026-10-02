// ==UserScript==
// @name         京东AI评价助手（全自动闭环）
// @version      1.1
// @namespace    https://github.com/yupaiLy/jd-auto-review
// @description  一个「开始/暂停」按钮控制的全自动评价闭环：评价列表→自动填评（大模型生成+打五星+晒单图配图）→发表→返回列表→进入下一单，循环至列表清空。适配京东新版评价中心（comment.m.jd.com/pc-static）。
// @author       twopair
// @license      MIT
// @homepageURL  https://github.com/yupaiLy/jd-auto-review
// @supportURL   https://github.com/yupaiLy/jd-auto-review/issues
// @icon         https://www.jd.com/favicon.ico
// @noframes
// @match        https://comment.m.jd.com/pc-static/center*
// @match        https://comment.m.jd.com/pc-static/publish*
// @match        https://comment.m.jd.com/pc-static/deliveryrate*
// @grant        GM_xmlhttpRequest
// @connect      api.deepseek.com
// @connect      club.jd.com
// @connect      360buyimg.com
// ==/UserScript==

(function() {
    'use strict';

    // ==================== 🛠️ 用户配置区域 ====================

    // 1. 请在此处填入您的 API 密钥 (必填)。出于安全，仓库内不保存真实密钥，请自行填入。
    const API_KEY = 'sk-xxx';

    // 2. 接口地址 (默认 DeepSeek 官方接口，可替换为 OpenAI / 智谱 GLM 等其他兼容 OpenAI 格式的地址)
    //    ⚠️ 更换接口域名后，需同步在脚本头部加一行 // @connect <接口域名>，否则 Tampermonkey 会拦截大模型请求
    const API_URL = 'https://api.deepseek.com/v1/chat/completions';

    // 3. 模型名称
    const MODEL_NAME = 'deepseek-flash';

    // 4. 各环节自动点击前的等待时间（毫秒）
    const AUTO_CLICK_DELAY = 3000;

    // 5. 是否自动配图：发表前抓取该商品晒单图随机上传（false 则跳过配图直接发表）
    const ENABLE_IMAGE = true;

    // 6. 每个商品上传几张晒单图：支持固定数字（如 2），或区间随机（如 '3-5'，每个商品单独随机取值）
    const IMG_PER_PRODUCT = '3-5';

    // 7. 配图上传完成的最长等待（毫秒）。检测不到完成信号时到点即发表，避免卡死
    const UPLOAD_WAIT_TIMEOUT = 12000;

    // =========================================================

    // ==================== 循环 / 暂停 状态 ====================
    // running：循环是否激活，需跨页面跳转存活，故落 localStorage。按钮据此显示「暂停」或「开始」。
    // currentStep：本页加载时算出的"当前步骤"，点「开始」时执行它。
    // resumeAction：暂停停在步骤边界时记下的断点续作，点「开始」优先执行它。
    // SKIP_KEY：跳过偏移。center 列表按顺序点第 N 个可评卡片；遇到暂不支持自动填写的
    //           送装/服务类评价（deliveryrate）时 N+1 再回列表，发表成功后清零。
    const LOOP_KEY = 'JD_AI_LOOP_RUNNING';
    const SKIP_KEY = 'JD_AI_SKIP_COUNT';
    const CENTER_URL = 'https://comment.m.jd.com/pc-static/center';
    let running = false;
    let currentStep = null;
    let resumeAction = null;

    function isRunning() {
        try { return localStorage.getItem(LOOP_KEY) === '1'; } catch (e) { return false; }
    }
    function setRunning(v) {
        running = v;
        try { v ? localStorage.setItem(LOOP_KEY, '1') : localStorage.removeItem(LOOP_KEY); } catch (e) {}
        renderToggleBtn();
    }
    function getSkipCount() {
        try { return parseInt(localStorage.getItem(SKIP_KEY) || '0', 10) || 0; } catch (e) { return 0; }
    }
    function setSkipCount(n) {
        try { n > 0 ? localStorage.setItem(SKIP_KEY, String(n)) : localStorage.removeItem(SKIP_KEY); } catch (e) {}
    }

    // 步骤边界：每个可被暂停打断的步骤前调用。若已暂停（running=false），记下断点并中止，返回 true。
    function haltIfPaused(resumeFn) {
        if (!running) {
            resumeAction = resumeFn;
            updateStatus('⏸ 已暂停。点击「开始」从当前步骤继续。', '#e4393c');
            return true;
        }
        return false;
    }

    // 1. 创建控制面板 UI
    function createUI() {
        const uiHTML = `
            <div id="ai-auto-review-ui" style="position: fixed; top: 30%; right: 20px; width: 260px; background: #fff; border: 2px solid #e4393c; border-radius: 8px; padding: 15px; z-index: 99999; box-shadow: 0 4px 12px rgba(0,0,0,0.15); font-family: 'Microsoft YaHei', sans-serif;">
                <h3 style="margin: 0 0 15px 0; font-size: 16px; color: #e4393c; text-align: center; border-bottom: 1px solid #eee; padding-bottom: 10px;">🤖 AI 自动评价助手</h3>
                <button id="ai-btn-toggle" style="width: 100%; padding: 10px; background: #28a745; color: #fff; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; font-weight: bold; margin-bottom: 10px;">开始</button>
                <div id="ai-status" style="font-size: 12px; color: #666; min-height: 40px; background: #f8f8f8; padding: 8px; border-radius: 4px; word-wrap: break-word; line-height: 1.5;">状态：等待页面加载...</div>
            </div>
        `;
        const holder = document.createElement('div');
        holder.innerHTML = uiHTML;
        document.body.appendChild(holder.firstElementChild);

        // 一个按钮两态：running→「暂停」，停止→「开始」
        document.getElementById('ai-btn-toggle').addEventListener('click', function() {
            if (running) {
                // 暂停：跑到下一个步骤边界即停
                setRunning(false);
                updateStatus('⏸ 暂停中…当前步骤完成后停止。', '#e4393c');
            } else {
                // 开始 / 继续：从断点或本页当前步骤继续
                setRunning(true);
                updateStatus('▶ 继续执行...', 'blue');
                const fn = resumeAction || currentStep;
                resumeAction = null;
                if (fn) fn();
            }
        });

        renderToggleBtn();
    }

    // 开始/暂停 两态外观
    function renderToggleBtn() {
        const btn = document.getElementById('ai-btn-toggle');
        if (!btn) return;
        if (running) {
            btn.textContent = '暂停';
            btn.style.background = '#f0ad4e';
        } else {
            btn.textContent = '开始';
            btn.style.background = '#28a745';
        }
    }

    // 2. 更新面板状态
    function updateStatus(text, color) {
        const box = document.getElementById('ai-status');
        if (box) {
            box.textContent = '状态：' + text;
            box.style.color = color || '#666';
        }
        console.log('[AI Auto Review]', text);
    }

    // ==================== 通用 DOM 工具（原生 JS，新评价中心是 React SPA） ====================

    // 元素是否可见（有实际占位面积）
    function visible(el) {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
    }
    function visibleAll(selector) {
        return Array.prototype.filter.call(document.querySelectorAll(selector), visible);
    }
    function visibleOne(selector) {
        return visibleAll(selector)[0] || null;
    }

    // 未登录检测（同步单次判定）：只看顶栏登录区 #ttbar-login-2024——
    // 登录后显示「你好，昵称」，未登录显示「你好，请登录」。仅在顶栏结构变更时
    // 才退化为全页扫描，且要求文案精确为「你好，请登录」，避免误伤登录弹窗等隐藏元素。
    function detectNotLoggedIn() {
        const bar = document.querySelector('#ttbar-login-2024');
        if (bar) return /请登录/.test(bar.textContent || '');
        const links = document.querySelectorAll('a');
        for (let i = 0; i < links.length; i++) {
            const a = links[i];
            const t = (a.textContent || '').trim();
            if (t === '你好，请登录' && visible(a)) return true;
        }
        return false;
    }

    // 未登录检测（异步）：顶栏登录状态由 passport JSONP 异步渲染——页面刚加载时先渲染
    // 未登录模板「你好，请登录」，登录用户的昵称要等接口返回才换上。跳回列表页瞬间
    // 立即判定会把已登录误判为未登录。这里轮询顶栏文本，稳定 2 秒
    // 不再变化（或超时 8s）才判定，确保等过模板→昵称的替换窗口。
    function notLoggedIn(cb) {
        const start = Date.now();
        let lastText = null;
        let lastChange = Date.now();
        const iv = setInterval(function() {
            const bar = document.querySelector('#ttbar-login-2024');
            const text = bar ? (bar.textContent || '').trim() : '';
            if (text !== lastText) { lastText = text; lastChange = Date.now(); }
            const stable = text.length > 0 && (Date.now() - lastChange) >= 2000;
            if (stable || Date.now() - start > 8000) {
                clearInterval(iv);
                cb(detectNotLoggedIn());
            }
        }, 300);
    }

    // 向 React 受控 textarea 填值：必须走原生 value setter，再派发 input 事件，
    // 否则 React 只更新 DOM value 不更新内部 state，发表时仍按空内容提交。
    function setNativeValue(el, value) {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
        setter.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    // 强制单标签页导航：把点击目标及其祖先链上的 <a>/<form> 的 target 设为 _self。
    function forceSameTabNav(el) {
        let node = el;
        while (node && node !== document.body) {
            const tag = node.tagName;
            if (tag === 'A' || tag === 'FORM') {
                node.setAttribute('target', '_self');
            }
            node = node.parentNode;
        }
    }

    // 点击期间临时把 window.open 改成"原地跳转"。新版列表页点「评价」按钮时
    // React onClick 内同步调用 window.open(publishUrl, "_blank")，此处接管后改为当前页跳转，
    // 保证整条闭环在单个标签页内完成。fn 跑完立即还原，并再加 500ms 保险还原。
    function withOpenGuard(fn) {
        const orig = window.open;
        let restored = false;
        const restore = function() {
            if (restored) return;
            restored = true;
            window.open = orig;
        };
        window.open = function(url) {
            try { if (url) location.href = url; } catch (e) {}
            return null;
        };
        try {
            fn();
        } finally {
            restore();
            setTimeout(restore, 500);
        }
    }

    // 通用：倒计时后自动点击目标元素。getEl 每次回调时重新求值，确保拿到最新 DOM。
    // 点击前是一个暂停边界；找不到目标则停止（onNotFound 可定制收尾，如结束循环）。
    // onClicked：点击成功后的回调（用于串接后续步骤，如发表后监听结果页）。
    function autoClickAfter(getEl, label, delay, onNotFound, onClicked) {
        delay = (delay == null) ? AUTO_CLICK_DELAY : delay;
        let remain = Math.ceil(delay / 1000);
        if (remain > 0) updateStatus(label + '：' + remain + '秒后自动点击...', 'blue');

        const timer = setInterval(function() {
            remain--;
            if (remain > 0) updateStatus(label + '：' + remain + '秒后自动点击...', 'blue');
        }, 1000);

        setTimeout(function() {
            clearInterval(timer);
            // 暂停边界：恢复时重跑本次点击（delay=0 立即执行）
            if (haltIfPaused(function() { autoClickAfter(getEl, label, 0, onNotFound, onClicked); })) return;

            const el = getEl();
            if (el) {
                updateStatus(label + '：已自动点击 ✅', 'green');
                // 单标签页导航：点击前中和 target="_blank"，并接管 window.open 兜底程序化开新页。
                try {
                    forceSameTabNav(el);
                    withOpenGuard(function() { el.click(); });
                } catch (e) {
                    updateStatus('单标签导航中和失败，退回普通点击：' + e, 'red');
                    el.click();
                }
                if (onClicked) onClicked();
            } else {
                updateStatus(label + '：未找到目标元素，流程已停止。', 'red');
                if (onNotFound) onNotFound();
            }
        }, delay);
    }

    // 3. 校验用户是否配置了秘钥
    function checkConfig() {
        if (!API_KEY || API_KEY === '请在此处填入你的API密钥' || API_KEY.trim() === '') {
            updateStatus('❌ 错误：请先在油猴脚本代码中配置您的 API_KEY！', 'red');
            return false;
        }
        return true;
    }

    // 4. 请求 大模型 API
    function generateProductReview(productName, successCallback, errorCallback) {
        console.log('productName', productName);
        GM_xmlhttpRequest({
            method: "POST",
            url: API_URL,
            headers: {
                "Content-Type": "application/json",
                "Authorization": "Bearer " + API_KEY
            },
            data: JSON.stringify({
                model: MODEL_NAME,
                messages: [
                    {
                        role: "system",
                        content: "你是一名真实的网购买家。我刚买了商品，商品全称是:【" + productName + "】。\n\n请写一段60到100字的商品评价，严格遵守以下纪律：\n1. 必须根据名称推断出它具体是什么东西（比如是保鲜膜、垃圾袋还是零食），然后只评价它该有的特定属性（如保鲜膜就评价粘性/厚度/好撕，垃圾袋评价承重/不漏）。\n2. 绝对禁止使用“物流快”、“客服好”、“包装严实”等万能模板废话。\n3. 不要把商品全名抄一遍，用“这款”、“这个”代替。\n4. 字数必须大于60个字。直接输出纯文本正文，绝对不要有任何前缀或提示语。"
                    }
                ]
            }),
            onload: function(response) {
                console.log(response)
                try {
                    const result = JSON.parse(response.responseText);
                    if (result.error) {
                        errorCallback(result.error.message || result.error.code || 'API 拒绝请求');
                        return;
                    }
                    const review = result.choices && result.choices.length > 0 ? result.choices[0].message.content : "";
                    if(review && review.length > 5) {
                        successCallback(review.trim());
                    } else {
                        errorCallback('返回内容过短或为空');
                    }
                } catch(e) {
                    errorCallback('解析服务器响应失败');
                }
            },
            onerror: function(error) {
                errorCallback('请求超时或网络错误');
            }
        });
    }

    // ==================== 评价中心列表页（/pc-static/center） ====================
    // 待评卡片 .wait-rate-card 的评价按钮 .rate-btn，点击后 React 调 window.open 打开发表页。
    // 聚合单卡片 .wait-rate-merge-card 顶部还有 .merge-btn（一次评整单多商品），DOM 顺序在其子卡片之前，优先命中。
    // 空列表时容器显示 .empty-list（「暂无数据」）。

    function runCenterStep(attempt) {
        attempt = attempt || 0;
        if (haltIfPaused(function() { runCenterStep(attempt); })) return;
        // 先等顶栏登录状态渲染稳定再判定（跳回列表页瞬间昵称可能尚未渲染，见 notLoggedIn 注释）
        notLoggedIn(function(nologin) {
            if (!running) { // 等待期间被暂停：记断点
                resumeAction = function() { runCenterStep(attempt); };
                updateStatus('⏸ 已暂停。点击「开始」从当前步骤继续。', '#e4393c');
                return;
            }
            if (nologin) {
                setRunning(false);
                updateStatus('❌ 检测到未登录，请先登录京东账号，再点「开始」。', 'red');
                return;
            }
            autoClickAfter(function() {
                const btns = visibleAll('.wait-rate-merge-card .merge-btn, .wait-rate-card .rate-btn');
                const skip = getSkipCount();
                // 跳过偏移耗尽：剩余卡片都无法自动处理（如全是送装类），终止循环防打转
                if (skip >= btns.length) return null;
                return btns[skip];
            }, '进入下一单评价', AUTO_CLICK_DELAY, function() {
                const container = document.querySelector('.wait-rate-list-container');
                const empty = container && container.querySelector('.empty-list');
                if (!container && attempt < 2) {
                    // 列表接口尚未返回（容器都未渲染），等一轮再试，避免误判空列表
                    updateStatus('待评价列表加载中，稍后重试...', 'blue');
                    setTimeout(function() { runCenterStep(attempt + 1); }, 3000);
                    return;
                }
                setRunning(false);
                const skipUsed = getSkipCount();
                setSkipCount(0);
                if (empty) {
                    updateStatus('🎉 待评价列表已空，循环结束。', 'green');
                } else if (skipUsed > 0) {
                    updateStatus('剩余待评价均为送装/服务类卡片（暂不支持自动填写），循环结束。', '#e4393c');
                } else {
                    updateStatus('未找到待评价卡片（列表为空或结构变更），流程已停止。', 'red');
                }
            });
        });
    }

    // ==================== 发表页（/pc-static/publish?orderId=&skuId=&commentType=） ====================
    // React SPA，同页三态：表单（.rate-comment 每商品一段）/ 成功（.rate-finish）/ 加载失败（.rate-error）。
    // 表单由 commentEditInfo 接口异步拉取，需轮询等待渲染。

    // 等待评价表单渲染：textarea 出现即回调其所在商品区块；出现错误态或超时则暂停并提示。
    function waitForForm(cb, timeout) {
        const deadline = Date.now() + (timeout || 20000);
        const iv = setInterval(function() {
            const textareas = visibleAll('.rate-comment-content-textarea');
            if (textareas.length > 0) {
                clearInterval(iv);
                // textarea → 反查其商品区块（.rate-comment；聚合评价页为 .rate-merge-section）
                const floors = [];
                const seen = {};
                textareas.forEach(function(ta) {
                    const floor = ta.closest('.rate-comment') || ta.closest('.rate-merge-section') || ta.parentElement;
                    if (floor && !seen[floor]) { seen[floor] = 1; floors.push(floor); }
                });
                cb(floors);
                return;
            }
            if (document.querySelector('.rate-error')) {
                clearInterval(iv);
                setRunning(false);
                resumeAction = function() { location.reload(); };
                updateStatus('❌ 评价信息加载失败（可能未登录或该单已失效/已评价）。已暂停，处理后点「开始」重试。', 'red');
                return;
            }
            if (Date.now() > deadline) {
                clearInterval(iv);
                setRunning(false);
                resumeAction = function() { location.reload(); };
                updateStatus('❌ 等待评价表单加载超时。已暂停，点「开始」重试。', 'red');
            }
        }, 500);
    }

    // 发表页主步骤：等表单 → 逐商品生成评价回填 → 打五星 → 配图（可选）→ 发表
    function startPublishProcess() {
        if (!checkConfig()) { setRunning(false); return; }
        updateStatus('正在等待评价表单加载...', 'blue');
        waitForForm(function(floors) {
            updateStatus('检测到 ' + floors.length + ' 个待评商品，准备开始处理...', 'blue');
            processFloor(0, floors);
        });
    }

    // 递归处理每一个商品区块
    function processFloor(index, floors) {
        if (index >= floors.length) {
            // 回填完毕：统一打五星，再配图（可选）、发表
            rateAllFiveStars();
            if (ENABLE_IMAGE) {
                updateStatus('✅ 评价已生成并打五星，开始自动配图...', 'green');
                uploadImagesThenSubmit(floors);
            } else {
                updateStatus('✅ 评价生成完毕，已打五星，准备自动发表...', 'green');
                submitStep(0);
            }
            return;
        }

        // 暂停边界：完成上一条、开始下一条之前
        if (haltIfPaused(function() { processFloor(index, floors); })) return;

        const floor = floors[index];
        const nameEl = floor.querySelector('.rate-comment-goods-title');
        const productName = (nameEl && nameEl.textContent.trim()) || '未知商品';
        const shortName = productName.length > 15 ? productName.substring(0, 15) + '...' : productName;

        updateStatus('正在生成 ' + (index + 1) + '/' + floors.length + ': ' + shortName, 'blue');

        generateProductReview(productName,
            function(review) {
                const ta = floor.querySelector('.rate-comment-content-textarea');
                if (ta) setNativeValue(ta, review);
                setTimeout(function() {
                    processFloor(index + 1, floors);
                }, 800);
            },
            function(errMsg) {
                // AI 生成失败：不兜底，直接暂停并说明原因。点「开始」从当前商品重试。
                setRunning(false);
                resumeAction = function() { processFloor(index, floors); };
                updateStatus('❌ 第 ' + (index + 1) + ' 个商品评价生成失败：' + errMsg + '。已暂停，排查后点「开始」重试。', 'red');
            }
        );
    }

    // 统一打五星：星级行 .scoreBox-conter-score-star-box 内每颗星按「索引+1」计分，
    // 点击第 5 颗（索引 4）即五星；兼容个别分组不足 5 颗的情况取最后一颗。
    function rateAllFiveStars() {
        const boxes = document.querySelectorAll('.scoreBox-conter-score-star-box');
        boxes.forEach(function(box) {
            const items = box.querySelectorAll('.scoreBox-conter-score-star-box-item');
            if (!items.length) return;
            const target = items[Math.min(4, items.length - 1)];
            target.click();
        });
    }

    // ==================== 自动配图（抓商品晒单图随机上传） ====================
    // 数据源：club.jd.com 晒单图接口（GM_xmlhttpRequest 跨域取 JSON，避开详情页风控与 JS 渲染）。
    // 上传：发表页上传区 .rate-comment-content-upload 内的 <input type="file">，
    //       用 DataTransfer 写 input.files + 派发 change 触发上传，绕过系统文件框。
    //       新版上传组件为京东自研 SDK，以上均为尽力而为：任何环节异常都跳过配图直接发表。

    // 发表步骤（含暂停边界与不可用重试）
    function submitStep(attempt) {
        attempt = attempt || 0;
        if (haltIfPaused(function() { submitStep(attempt); })) return;
        autoClickAfter(function() {
            const btn = visibleOne('.rate-publish-submit-button');
            // 灰置按钮（.disabled）点了无效，交由 onNotFound 重试
            return (btn && !btn.classList.contains('disabled')) ? btn : null;
        }, '自动发表评价', 1500, function() {
            const btn = document.querySelector('.rate-publish-submit-button');
            if (btn && attempt < 5) {
                updateStatus('「发表」按钮暂不可用（星级/内容校验可能未通过），稍后重试...', 'blue');
                setTimeout(function() { submitStep(attempt + 1); }, 2500);
            } else {
                setRunning(false);
                resumeAction = function() { submitStep(0); };
                updateStatus('❌ 未找到可用的「发表」按钮。已暂停，检查页面后点「开始」重试。', 'red');
            }
        }, watchPublishResult);
    }

    // 发表点击后监听同页结果态：.rate-finish 成功 / 超时未成功则暂停
    function watchPublishResult() {
        const deadline = Date.now() + 25000;
        const iv = setInterval(function() {
            if (document.querySelector('.rate-finish')) {
                clearInterval(iv);
                setSkipCount(0); // 本单发表成功，清除跳过偏移（该卡片已从列表消失）
                successReturnStep();
                return;
            }
            if (Date.now() > deadline) {
                clearInterval(iv);
                setRunning(false);
                resumeAction = function() { location.reload(); };
                updateStatus('❌ 发表后未检测到成功页（可能失败或触发验证）。已暂停，检查页面后点「开始」重试。', 'red');
            }
        }, 800);
    }

    // 成功页步骤：点击「返回待评价列表」（.rate-finish-return，原地跳回 center）
    function successReturnStep() {
        autoClickAfter(function() {
            return visibleOne('.rate-finish-return');
        }, '返回待评价列表', 1500, function() {
            // 找不到返回按钮：兜底直接跳回列表页
            updateStatus('未找到返回按钮，直接跳回评价列表...', 'blue');
            setTimeout(function() { location.href = CENTER_URL; }, 1000);
        });
    }

    // 解析配图张数配置：固定数字（如 2）或区间随机（如 '3-5' / '3~5'，每次调用单独随机）。
    // 区间端点写反时自动交换；非法配置按 0 处理（跳过配图，不阻断闭环）。
    function pickImageCount() {
        const raw = String(IMG_PER_PRODUCT).trim();
        const m = raw.match(/^(\d+)\s*[-~]\s*(\d+)$/);
        if (m) {
            let lo = parseInt(m[1], 10), hi = parseInt(m[2], 10);
            if (lo > hi) { const t = lo; lo = hi; hi = t; }
            return lo + Math.floor(Math.random() * (hi - lo + 1));
        }
        const n = parseInt(raw, 10);
        return isNaN(n) ? 0 : Math.max(0, n);
    }

    // 洗牌取前 n 个
    function pickRandom(arr, n) {
        const a = arr.slice();
        for (let i = a.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            const t = a[i]; a[i] = a[j]; a[j] = t;
        }
        return a.slice(0, n);
    }

    // 按 skuId 取晒单图 URL 列表（跨域 GM_xmlhttpRequest）
    function fetchShaidanImages(sku) {
        const api = 'https://club.jd.com/discussion/getProductPageImageCommentList.action?productId=' +
                    sku + '&isShadowSku=0&page=1&pageSize=10';
        return new Promise(function(resolve) {
            GM_xmlhttpRequest({
                method: 'GET', url: api, timeout: 8000,
                onload: function(r) {
                    try {
                        const d = JSON.parse(r.responseText);
                        resolve((d && d.imgComments && d.imgComments.imgList)
                            ? d.imgComments.imgList.map(function(x) { return x.imageUrl; }).filter(Boolean)
                            : []);
                    } catch (e) { resolve([]); }
                },
                onerror: function() { resolve([]); },
                ontimeout: function() { resolve([]); }
            });
        });
    }

    // 跨域抓图为 Blob（图片在 360buyimg.com，需 GM_xmlhttpRequest + @connect）
    function fetchImageBlob(url) {
        return new Promise(function(resolve, reject) {
            GM_xmlhttpRequest({
                method: 'GET', url: url, responseType: 'blob', timeout: 15000,
                onload: function(r) {
                    (r.status >= 200 && r.status < 300 && r.response) ? resolve(r.response) : reject('HTTP ' + r.status);
                },
                onerror: function() { reject('网络错误'); },
                ontimeout: function() { reject('超时'); }
            });
        });
    }

    // 把任意格式的图片 Blob 重新编码成真 JPEG File。
    // 必要性：360buyimg CDN 对 .jpg 晒单图常按内容协商返回 webp 字节，京东上传按 magic bytes
    // 校验会判定非 jpg/png/gif/bmp 而拒收。经 canvas 重编码可保证为真 JPEG，并顺带限制尺寸 (<4M)。
    // 关键：blob 经 blob: URL 加载到 Image 属同源，不会污染 canvas，toBlob 可正常导出。
    function blobToJpegFile(blob, name) {
        return new Promise(function(resolve, reject) {
            const objUrl = URL.createObjectURL(blob);
            const img = new Image();
            img.onload = function() {
                URL.revokeObjectURL(objUrl);
                let w = img.naturalWidth, h = img.naturalHeight;
                if (!w || !h) { reject('图片尺寸为 0'); return; }
                const MAX = 1920; // 限制最长边，保证 JPEG 体积远小于 4M
                if (Math.max(w, h) > MAX) {
                    const s = MAX / Math.max(w, h);
                    w = Math.round(w * s); h = Math.round(h * s);
                }
                const cv = document.createElement('canvas');
                cv.width = w; cv.height = h;
                const ctx = cv.getContext('2d');
                ctx.fillStyle = '#ffffff'; // 白底，避免透明图转 jpg 出现黑块
                ctx.fillRect(0, 0, w, h);
                ctx.drawImage(img, 0, 0, w, h);
                cv.toBlob(function(jpg) {
                    jpg ? resolve(new File([jpg], name, { type: 'image/jpeg' })) : reject('toBlob 失败');
                }, 'image/jpeg', 0.85);
            };
            img.onerror = function() { URL.revokeObjectURL(objUrl); reject('图片解码失败'); };
            img.src = objUrl;
        });
    }

    // 把若干 File 注入到指定 file input 并触发上传
    function injectFiles(input, files) {
        const dt = new DataTransfer();
        files.forEach(function(f) { dt.items.add(f); });
        input.files = dt.files;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    // 定位商品区块对应的 file input：优先该区块上传区内的，退化到全页唯一的一个
    function findUploadInput(floor) {
        const scoped = floor.querySelectorAll('.rate-comment-content-upload input[type="file"]');
        if (scoped.length) return scoped[0];
        const all = document.querySelectorAll('input[type="file"]');
        return all.length === 1 ? all[0] : null;
    }

    // 单个商品区块：抓晒单图 → 随机取 N 张 → 下载为 File → 注入上传。返回成功注入的张数。
    function uploadForFloor(floor, sku) {
        updateStatus('配图：抓取 sku ' + sku + ' 晒单图...', 'blue');
        const input = findUploadInput(floor);
        if (!input) {
            updateStatus('sku ' + sku + ' 未找到上传入口，跳过配图', '#e4393c');
            return Promise.resolve(0);
        }
        return fetchShaidanImages(sku).then(function(urls) {
            if (!urls.length) { updateStatus('sku ' + sku + ' 无晒单图，跳过配图', '#e4393c'); return 0; }
            const want = pickImageCount();
            if (want <= 0) { updateStatus('sku ' + sku + ' 配图张数配置为 0，跳过配图', '#e4393c'); return 0; }
            const picks = pickRandom(urls, want); // 晒单图不足 want 张时取全部可用
            const tasks = picks.map(function(u, i) {
                let url = u.indexOf('//') === 0 ? 'https:' + u : u;
                url = url.replace(/\.dpg(\?|$)/, '$1'); // 去 .dpg 保险（接口一般已是 .jpg）
                return fetchImageBlob(url)
                    .then(function(blob) { return blobToJpegFile(blob, 'shaidan_' + sku + '_' + i + '.jpg'); })
                    .catch(function() { return null; });
            });
            return Promise.all(tasks).then(function(files) {
                files = files.filter(Boolean);
                if (!files.length) {
                    updateStatus('sku ' + sku + ' 图片下载失败，跳过配图', '#e4393c');
                    return 0;
                }
                injectFiles(input, files);
                updateStatus('sku ' + sku + ' 已注入 ' + files.length + ' 张图，上传中...', 'green');
                return files.length;
            });
        });
    }

    // 等待上传完成：统计各商品上传区出现的缩略图（非 data: 占位）数 ≥ 期望张数；到点即返回，避免卡死
    function waitFloorUploads(floors, min, timeout) {
        return new Promise(function(resolve) {
            const start = Date.now();
            const iv = setInterval(function() {
                let n = 0;
                floors.forEach(function(f) {
                    f.querySelectorAll('.rate-comment-content-upload img').forEach(function(img) {
                        const src = img.getAttribute('src') || '';
                        if (src && src.indexOf('data:') !== 0) n++;
                    });
                });
                if (n >= min || (Date.now() - start) > timeout) { clearInterval(iv); resolve(n); }
            }, 600);
        });
    }

    // 配图主流程：逐商品配图 → 等上传 → 发表。任何异常都跳过配图直接发表，不阻断闭环。
    function uploadImagesThenSubmit(floors) {
        const resume = function() { uploadImagesThenSubmit(floors); };
        if (haltIfPaused(resume)) return;

        try {
            // sku 来源：发表页 URL 的 skuId 参数。普通单一单一件；聚合单为逗号分隔的多个 sku，
            // 与商品区块按出现顺序一一对应（数量不齐时循环取用，反正失败即跳过）。
            const skuIds = (new URLSearchParams(location.search).get('skuId') || '').split(',').filter(Boolean);
            if (!skuIds.length) { submitStep(0); return; }

            let expected = 0;
            // 串行处理各商品，便于暂停与状态显示
            let chain = Promise.resolve();
            floors.forEach(function(floor, i) {
                chain = chain.then(function() {
                    if (!running) { resumeAction = resume; updateStatus('⏸ 已暂停。', '#e4393c'); throw 'PAUSED'; }
                    return uploadForFloor(floor, skuIds[i % skuIds.length]).then(function(n) { expected += n; });
                });
            });

            chain.then(function() {
                if (expected > 0) {
                    updateStatus('共注入 ' + expected + ' 张晒单图，等待上传完成...', 'blue');
                    return waitFloorUploads(floors, expected, UPLOAD_WAIT_TIMEOUT);
                }
            }).then(function() {
                submitStep(0);
            }).catch(function(e) {
                if (e === 'PAUSED') return; // 暂停：已记录断点，等「开始」
                updateStatus('配图异常，跳过配图直接发表：' + e, 'red');
                submitStep(0);
            });
        } catch (e) {
            if (e === 'PAUSED') return;
            updateStatus('配图异常，跳过配图直接发表：' + e, 'red');
            submitStep(0);
        }
    }

    // ==================== 送装/服务类评价页（/pc-static/deliveryrate） ====================
    // 该页为独立的骑手/商家服务评价 UI，暂不支持自动填写。跳过该单：偏移 +1 后回列表，
    // 列表页将点击下一个可评卡片。发表成功后偏移清零，保证已发表卡片移出列表后偏移不错位。

    function runDeliveryrateSkipStep() {
        updateStatus('该单为送装/服务类评价（暂不支持自动填写），将跳过...', 'blue');
        if (haltIfPaused(runDeliveryrateSkipStep)) return;
        notLoggedIn(function(nologin) {
            if (!running) {
                resumeAction = runDeliveryrateSkipStep;
                updateStatus('⏸ 已暂停。点击「开始」从当前步骤继续。', '#e4393c');
                return;
            }
            if (nologin) {
                setRunning(false);
                updateStatus('❌ 检测到未登录，请先登录京东账号，再点「开始」。', 'red');
                return;
            }
            setSkipCount(getSkipCount() + 1);
            setTimeout(function() {
                location.href = CENTER_URL;
            }, 2000);
        });
    }

    // 5. 页面加载完成后按路由分发：算出本页 currentStep，running 则自动执行，否则等「开始」
    function boot() {
        createUI();
        running = isRunning();
        renderToggleBtn();

        const path = location.pathname;

        if (path.indexOf('/pc-static/publish') !== -1) {
            currentStep = startPublishProcess;
        } else if (path.indexOf('/pc-static/deliveryrate') !== -1) {
            currentStep = runDeliveryrateSkipStep;
        } else if (path.indexOf('/pc-static/center') !== -1) {
            currentStep = runCenterStep;
        } else {
            currentStep = null;
            updateStatus('当前页面不在自动评价闭环范围内。', '#e4393c');
            return;
        }

        if (running) {
            // 循环中：自动执行本页步骤。发表页表单异步加载，先留 2.5s 等接口渲染；其余步骤自带倒计时。
            if (currentStep === startPublishProcess) {
                updateStatus('循环中，2秒后开始本单评价...', 'blue');
                setTimeout(function() { if (running) startPublishProcess(); }, 2500);
            } else {
                currentStep();
            }
        } else {
            updateStatus('点击「开始」启动 / 继续自动评价循环。', 'blue');
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
