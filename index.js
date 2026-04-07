/**
 * Gmail 收件 助手 - Cloudflare Worker 版
 * 功能：访问密码、OAuth 授权、读取最近10分钟邮件、一键复制
 */

const HTML_TEMPLATE = (content, script = "") => `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>收件 助手</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600&display=swap');
        body { font-family: 'Inter', sans-serif; background-color: #f8fafc; color: #1e293b; }
        .card { transition: transform 0.2s; }
        .card:hover { transform: translateY(-2px); }
    </style>
</head>
<body class="p-4 md:p-8">
    <div class="max-w-3xl mx-auto">${content}</div>
    <script>${script}</script>
</body>
</html>
`;

// 校验登录状态 (Cookie 验证)
function isAuthorized(request, env) {
    const cookie = request.headers.get('Cookie') || "";
    const authCookie = cookie.split('; ').find(row => row.trim().startsWith('auth_pass='));
    return authCookie && authCookie.split('=')[1] === env.ACCESS_PASSWORD;
}

// 自动刷新 Access Token
async function refreshAccessToken(env) {
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
    if (!data.access_token) throw new Error('Refresh Token 无效或未配置');
    return data.access_token;
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const redirect_uri = `https://${url.hostname}/callback`;

        // --- 路由 1: 登录界面 ---
        if (url.pathname === '/login') {
            if (request.method === 'POST') {
                const formData = await request.formData();
                const pass = formData.get('password');
                if (pass === env.ACCESS_PASSWORD) {
                    return new Response("OK", {
                        status: 302,
                        headers: { 
                            'Location': '/',
                            'Set-Cookie': `auth_pass=${pass}; Path=/; HttpOnly; Max-Age=2592000; SameSite=Lax` 
                        }
                    });
                }
            }
            const loginView = `
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
                </div>`;
            return new Response(HTML_TEMPLATE(loginView), { headers: { 'Content-Type': 'text/html' } });
        }

        // 拦截未登录请求
        if (!isAuthorized(request, env) && url.pathname !== '/callback') {
            return Response.redirect(`${url.origin}/login`, 302);
        }

        // --- 路由 2: 授权起点 ---
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

        // --- 路由 3: 回调处理并显示复制按钮 ---
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
                <div class="bg-white p-8 rounded-2xl shadow-lg border border-slate-200 mt-10 text-center">
                    <div class="text-5xl mb-4">🚀</div>
                    <h1 class="text-2xl font-bold text-slate-800 mb-2">获取成功</h1>
                    <p class="text-slate-500 mb-8">请复制并在 Worker 变量 REFRESH_TOKEN 中更新：</p>
                    <div class="bg-slate-900 text-blue-400 p-5 rounded-xl mb-6 break-all font-mono text-sm text-left relative group">
                        <span id="tokenText">${data.refresh_token || '未找到 Token，请重试'}</span>
                    </div>
                    <button id="copyBtn" onclick="copyToken()" class="w-full bg-blue-600 text-white font-bold py-4 rounded-xl hover:bg-blue-700 transition-all">复制令牌</button>
                    <a href="/" class="block mt-6 text-slate-400 hover:text-blue-600 text-sm">完成配置后返回首页</a>
                </div>`;
            const script = `
                function copyToken() {
                    const text = document.getElementById('tokenText').innerText;
                    navigator.clipboard.writeText(text).then(() => {
                        const btn = document.getElementById('copyBtn');
                        btn.innerText = '已复制！';
                        btn.classList.replace('bg-blue-600', 'bg-green-600');
                        setTimeout(() => {
                            btn.innerText = '复制令牌';
                            btn.classList.replace('bg-green-600', 'bg-blue-600');
                        }, 2000);
                    });
                }
            `;
            return new Response(HTML_TEMPLATE(content, script), { headers: { 'Content-Type': 'text/html' } });
        }

        // --- 路由 4: 邮件列表首页 (只读最近 10 分钟) ---
        try {
            const accessToken = await refreshAccessToken(env);
            const tenMinsAgo = Math.floor(Date.now() / 1000) - 600;
            
            // 使用 q=after:时间戳 过滤 10 分钟内的邮件
            const gmailResp = await fetch(
                `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=15&q=after:${tenMinsAgo}`, 
                { headers: { Authorization: `Bearer ${accessToken}` } }
            );
            const listData = await gmailResp.json();

            let mailCards = "";
            if (listData.messages && listData.messages.length > 0) {
                const mails = await Promise.all(listData.messages.map(async (m) => {
                    const d = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}`, {
                        headers: { Authorization: `Bearer ${accessToken}` },
                    }).then(r => r.json());
                    const h = d.payload.headers;
                    const date = new Date(parseInt(d.internalDate));
                    return {
                        subject: h.find(x => x.name === 'Subject')?.value || '无主题',
                        from: h.find(x => x.name === 'From')?.value || '未知发件人',
                        to: h.find(x => x.name === 'To')?.value || '',
                        time: date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
                        snippet: d.snippet
                    };
                }));

                // 页面搜索过滤
                const targetTo = url.searchParams.get('to') || "";
                const filtered = targetTo ? mails.filter(m => m.to.toLowerCase().includes(targetTo.toLowerCase())) : mails;

                mailCards = filtered.map(m => `
                    <div class="card bg-white p-6 rounded-2xl shadow-sm border border-slate-100 mb-4">
                        <div class="flex justify-between items-start mb-2">
                            <span class="text-xs font-bold text-blue-500 uppercase tracking-widest">${m.from.split('<')[0]}</span>
                            <span class="text-xs text-slate-400 font-mono">${m.time}</span>
                        </div>
                        <h3 class="text-lg font-bold text-slate-800 mb-2">${m.subject}</h3>
                        <p class="text-slate-500 text-sm leading-relaxed mb-4">${m.snippet}</p>
                        <div class="flex items-center gap-2 text-[10px] text-slate-300 font-mono pt-3 border-t border-slate-50">
                            <span>TO: ${m.to}</span>
                        </div>
                    </div>
                `).join('');
                
                if (filtered.length === 0) mailCards = `<div class="text-center py-20 text-slate-400">符合过滤条件的邮件不存在</div>`;
            } else {
                mailCards = `
                    <div class="text-center py-20 bg-white rounded-2xl border-2 border-dashed border-slate-100">
                        <div class="text-4xl mb-4">☕</div>
                        <p class="text-slate-400">最近 10 分钟内没有新邮件</p>
                    </div>`;
            }

            const mainContent = `
                <div class="flex justify-between items-center mb-10">
                    <div>
                        <h1 class="text-3xl font-extrabold text-slate-900 tracking-tight">收件箱</h1>
                        <p class="text-slate-400 text-sm mt-1">监控最近 10 分钟的动态</p>
                    </div>
                    <div class="flex gap-3">
                        <button onclick="location.reload()" class="bg-blue-600 text-white px-5 py-2.5 rounded-xl font-bold text-sm shadow-lg shadow-blue-100 hover:bg-blue-700 transition-all">刷新</button>
                    </div>
                </div>
                <form class="mb-8 flex gap-3">
                    <input type="text" name="to" value="${url.searchParams.get('to') || ''}" placeholder="按收件人过滤..." class="flex-1 p-4 bg-white rounded-xl border border-slate-200 outline-none focus:ring-2 focus:ring-blue-500 transition-all shadow-sm">
                    <button class="bg-slate-800 text-white px-8 rounded-xl font-bold hover:bg-slate-900 transition-all">搜索</button>
                </form>
                <div class="space-y-2">${mailCards}</div>
            `;
            return new Response(HTML_TEMPLATE(mainContent), { headers: { 'Content-Type': 'text/html' } });

        } catch (e) {
            const errorView = `
                <div class="text-center py-24 bg-white rounded-3xl border border-slate-100 shadow-sm mt-10">
                    <div class="text-5xl mb-6">⚙️</div>
                    <h2 class="text-2xl font-bold text-slate-800 mb-3">系统初始化</h2>
                    <p class="text-slate-400 mb-10 max-w-sm mx-auto text-sm leading-relaxed">检测到未配置有效的 Refresh Token。请确保已在后台配置 Client ID，然后开始授权流程。</p>
                    <a href="/auth" class="inline-block bg-blue-600 text-white px-12 py-4 rounded-2xl font-bold hover:bg-blue-700 shadow-xl shadow-blue-100 transition-all">开始首次授权</a>
                </div>`;
            return new Response(HTML_TEMPLATE(errorView), { headers: { 'Content-Type': 'text/html' } });
        }
    }
};
