/**
 * Gmail 助手 - 进阶性能优化版 (KV 缓存 + 密码保护)
 * 2026 稳定运行版
 */

const HTML_TEMPLATE = (content, script = "") => `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>收件 助手 Pro</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&display=swap');
        body { font-family: 'Inter', sans-serif; background-color: #f8fafc; color: #1e293b; }
        .glass { background: rgba(255, 255, 255, 0.8); backdrop-filter: blur(10px); }
    </style>
</head>
<body class="p-4 md:p-8">
    <div class="max-w-3xl mx-auto">${content}</div>
    <script>${script}</script>
</body>
</html>
`;

// --- 身份校验逻辑 ---
function isAuthorized(request, env) {
    const cookie = request.headers.get('Cookie') || "";
    const authCookie = cookie.split('; ').find(row => row.trim().startsWith('auth_pass='));
    return authCookie && authCookie.split('=')[1] === env.ACCESS_PASSWORD;
}

// --- 核心优化：带 KV 缓存的 Token 获取 ---
async function getAccessToken(env) {
    const KV_KEY = "access_token_cache";
    
    // 1. 尝试从 KV 读取
    const cached = await env.GMAIL_KV.get(KV_KEY);
    if (cached) return cached;

    // 2. 缓存失效，向 Google 刷新
    const resp = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            client_id: env.CLIENT_ID,
            client_secret: env.CLIENT_SECRET,
            refresh_token: env.REFRESH_TOKEN,
            grant_type: 'refresh_token',
        }),
    });
    
    const data = await resp.json();
    if (!data.access_token) throw new Error('REFRESH_TOKEN_INVALID');

    // 3. 存入 KV，有效期 50 分钟 (3000秒)
    await env.GMAIL_KV.put(KV_KEY, data.access_token, { expirationTtl: 3000 });
    return data.access_token;
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const redirect_uri = `https://${url.hostname}/callback`;

        // --- 路由：登录 ---
        if (url.pathname === '/login') {
            if (request.method === 'POST') {
                const formData = await request.formData();
                if (formData.get('password') === env.ACCESS_PASSWORD) {
                    return new Response("OK", {
                        status: 302,
                        headers: { 
                            'Location': '/',
                            'Set-Cookie': `auth_pass=${env.ACCESS_PASSWORD}; Path=/; HttpOnly; Max-Age=2592000; SameSite=Lax` 
                        }
                    });
                }
            }
            return new Response(HTML_TEMPLATE(`
                <div class="max-w-md mx-auto mt-24 bg-white p-8 rounded-2xl shadow-xl border border-slate-100">
                    <div class="text-center mb-8">
                        <div class="text-4xl mb-2">🔒</div>
                        <h2 class="text-2xl font-bold text-slate-800">身份验证</h2>
                        <p class="text-slate-400 text-sm">请输入访问密码以继续</p>
                    </div>
                    <form method="POST" class="space-y-4">
                        <input type="password" name="password" autofocus class="w-full p-4 bg-slate-50 border border-slate-200 rounded-xl outline-none focus:ring-2 focus:ring-blue-500 transition-all" placeholder="输入密码..." required>
                        <button class="w-full bg-blue-600 text-white font-bold py-4 rounded-xl hover:bg-blue-700 shadow-lg shadow-blue-100 transition-all">验证进入</button>
                    </form>
                </div>
            `), { headers: { 'Content-Type': 'text/html' } });
        }

        // 鉴权拦截
        if (!isAuthorized(request, env) && url.pathname !== '/callback') {
            return Response.redirect(`${url.origin}/login`, 302);
        }

        // --- 路由：OAuth 授权起点 ---
        if (url.pathname === '/auth') {
            const googleUrl = `https://accounts.google.com/o/oauth2/v2/auth?` + 
                new URLSearchParams({
                    client_id: env.CLIENT_ID,
                    redirect_uri: redirect_uri,
                    response_type: 'code',
                    scope: 'https://www.googleapis.com/auth/gmail.readonly',
                    access_type: 'offline',
                    prompt: 'consent'
                }).toString();
            return Response.redirect(googleUrl, 302);
        }

        // --- 路由：OAuth 回调 ---
        if (url.pathname === '/callback') {
            const code = url.searchParams.get('code');
            const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    client_id: env.CLIENT_ID,
                    client_secret: env.CLIENT_SECRET,
                    code,
                    grant_type: 'authorization_code',
                    redirect_uri
                }),
            });
            const data = await tokenResp.json();
            const content = `
                <div class="bg-white p-10 rounded-3xl shadow-xl border border-slate-100 mt-10 text-center">
                    <div class="text-6xl mb-6">🔑</div>
                    <h1 class="text-2xl font-extrabold text-slate-800 mb-2">获取成功</h1>
                    <p class="text-slate-400 mb-8 text-sm text-balance">请将下方 Token 更新到 Worker 环境变量 REFRESH_TOKEN 中</p>
                    <div class="bg-slate-900 text-green-400 p-6 rounded-2xl mb-8 break-all font-mono text-xs text-left" id="tokenText">${data.refresh_token || '未获取到，请重试'}</div>
                    <button id="copyBtn" onclick="copyToken()" class="w-full bg-blue-600 text-white font-bold py-4 rounded-2xl hover:bg-blue-700 transition-all">一键复制令牌</button>
                    <a href="/" class="block mt-6 text-slate-300 hover:text-blue-500 text-xs">配置完成后点此返回主页</a>
                </div>`;
            const script = `function copyToken() {
                const text = document.getElementById('tokenText').innerText;
                navigator.clipboard.writeText(text).then(() => {
                    const btn = document.getElementById('copyBtn');
                    btn.innerText = '已成功复制！';
                    btn.className = 'w-full bg-green-600 text-white font-bold py-4 rounded-2xl transition-all';
                    setTimeout(() => {
                        btn.innerText = '一键复制令牌';
                        btn.className = 'w-full bg-blue-600 text-white font-bold py-4 rounded-2xl transition-all';
                    }, 2000);
                });
            }`;
            return new Response(HTML_TEMPLATE(content, script), { headers: { 'Content-Type': 'text/html' } });
        }

        // --- 路由：邮件主页 ---
        try {
            const accessToken = await getAccessToken(env);
            const tenMinsAgo = Math.floor(Date.now() / 1000) - 600;
            
            // 请求最近 10 分钟邮件
            const gmailResp = await fetch(
                `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=10&q=after:${tenMinsAgo}`, 
                { headers: { Authorization: `Bearer ${accessToken}` } }
            );
            const listData = await gmailResp.json();

            // 如果缓存 Token 导致 401 报错，清理缓存并刷新
            if (listData.error && listData.error.code === 401) {
                await env.GMAIL_KV.delete("access_token_cache");
                return new Response("Token Sync Error, Refreshing...", { status: 302, headers: { 'Location': '/' } });
            }

            let mailHtml = "";
            if (listData.messages && listData.messages.length > 0) {
                const mails = await Promise.all(listData.messages.map(async (m) => {
                    const d = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}`, {
                        headers: { Authorization: `Bearer ${accessToken}` },
                    }).then(r => r.json());
                    const h = d.payload.headers;
                    return {
                        subject: h.find(x => x.name === 'Subject')?.value || '(无主题)',
                        from: h.find(x => x.name === 'From')?.value || '未知',
                        to: h.find(x => x.name === 'To')?.value || '',
                        snippet: d.snippet,
                        time: new Date(parseInt(d.internalDate)).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
                    };
                }));

                const targetTo = url.searchParams.get('to') || "";
                const filtered = targetTo ? mails.filter(m => m.to.toLowerCase().includes(targetTo.toLowerCase())) : mails;

                mailHtml = filtered.map(m => `
                    <div class="bg-white p-6 rounded-2xl shadow-sm border border-slate-100 mb-4 hover:border-blue-200 transition-all">
                        <div class="flex justify-between items-center mb-3">
                            <span class="text-[10px] font-black text-blue-600 uppercase tracking-widest bg-blue-50 px-2 py-0.5 rounded">${m.from.split('<')[0].trim() || 'System'}</span>
                            <span class="text-[10px] text-slate-300 font-bold">${m.time}</span>
                        </div>
                        <h3 class="text-base font-bold text-slate-800 mb-2 leading-snug">${m.subject}</h3>
                        <p class="text-slate-400 text-xs leading-relaxed line-clamp-2">${m.snippet}</p>
                        <div class="mt-4 pt-4 border-t border-slate-50 flex items-center text-[9px] text-slate-300 font-mono">
                            <span class="truncate">TO: ${m.to}</span>
                        </div>
                    </div>
                `).join('');
                if (filtered.length === 0) mailHtml = `<div class="text-center py-20 text-slate-400 text-sm">匹配过滤条件的邮件不存在</div>`;
            } else {
                mailHtml = `<div class="text-center py-24 bg-white rounded-3xl border border-slate-50 shadow-inner">
                    <div class="text-5xl mb-4 opacity-20">📭</div>
                    <p class="text-slate-300 text-sm font-medium">最近 10 分钟内没有新邮件</p>
                </div>`;
            }

            const pageView = `
                <div class="flex justify-between items-end mb-10 pt-4">
                    <div>
                        <h1 class="text-4xl font-black text-slate-900 tracking-tighter">INBOX</h1>
                        <p class="text-slate-400 text-[10px] font-bold uppercase tracking-widest mt-1">10-Minute Realtime Monitor</p>
                    </div>
                    <div class="flex gap-2">
                        <button onclick="location.reload()" class="bg-blue-600 text-white px-6 py-2 rounded-xl font-bold text-xs shadow-lg shadow-blue-100 hover:scale-105 active:scale-95 transition-all">刷新</button>
                    </div>
                </div>
                <form class="mb-8 flex gap-2">
                    <input type="text" name="to" value="${url.searchParams.get('to') || ''}" placeholder="按收件人过滤..." class="flex-1 p-4 bg-white rounded-2xl border border-slate-100 outline-none focus:ring-2 focus:ring-blue-500 text-sm transition-all shadow-sm">
                    <button class="bg-slate-900 text-white px-8 rounded-2xl font-bold text-sm">搜索</button>
                </form>
                <div class="pb-10">${mailHtml}</div>
            `;
            return new Response(HTML_TEMPLATE(pageView), { headers: { 'Content-Type': 'text/html' } });

        } catch (e) {
            const errorView = `
                <div class="text-center py-24 bg-white rounded-3xl border border-slate-100 shadow-sm mt-10 px-6">
                    <div class="text-5xl mb-6">🛠️</div>
                    <h2 class="text-xl font-black text-slate-800 mb-3">需要初始化授权</h2>
                    <p class="text-slate-400 mb-10 text-xs leading-relaxed max-w-xs mx-auto">请确保已在 Cloudflare 后台配置 CLIENT_ID 和 SECRET，然后点击下方按钮开始 OAuth 流程。</p>
                    <a href="/auth" class="inline-block bg-blue-600 text-white px-12 py-4 rounded-2xl font-bold hover:bg-blue-700 shadow-xl shadow-blue-100 transition-all">开始首次授权</a>
                </div>`;
            return new Response(HTML_TEMPLATE(errorView), { headers: { 'Content-Type': 'text/html' } });
        }
    }
};
