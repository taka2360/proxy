from flask import Flask, request, Response, send_from_directory, render_template
import requests as http_requests
from urllib.parse import urljoin, urlparse, quote, unquote
import base64
import re
from threading import Thread
import urllib3

# SSL証明書検証の警告を抑制
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

# ボット判定を回避するためのデフォルトUser-Agent
DEFAULT_USER_AGENT = (
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
    'AppleWebKit/537.36 (KHTML, like Gecko) '
    'Chrome/131.0.0.0 Safari/537.36'
)

app = Flask(__name__)

# --- URLエンコード/デコード ---

def encode_url(url: str) -> str:
    """URLをBase64エンコードする (URLセーフ)"""
    return base64.urlsafe_b64encode(url.encode('utf-8')).decode().rstrip('=')

def decode_url(encoded: str) -> str:
    """Base64エンコードされたURLをデコードする"""
    # パディング復元
    padding = 4 - len(encoded) % 4
    if padding != 4:
        encoded += '=' * padding
    return base64.urlsafe_b64decode(encoded.encode('utf-8')).decode('utf-8')

def proxy_url(target_url: str) -> str:
    """対象URLをプロキシURL形式に変換する"""
    return f'/p/{encode_url(target_url)}'

def get_origin(url: str) -> str:
    """URLからオリジンを取得する"""
    parsed = urlparse(url)
    return f'{parsed.scheme}://{parsed.netloc}'

# --- ヘッダー処理 ---

# 転送しないリクエストヘッダー
SKIP_REQUEST_HEADERS = {
    'host', 'connection', 'accept-encoding', 'content-length',
    'transfer-encoding', 'upgrade-insecure-requests',
}

# 転送しないレスポンスヘッダー
SKIP_RESPONSE_HEADERS = {
    'transfer-encoding', 'content-encoding', 'content-length',
    'connection', 'keep-alive', 'content-security-policy',
    'content-security-policy-report-only', 'strict-transport-security',
    'x-frame-options', 'x-content-type-options',
    'x-xss-protection', 'cross-origin-opener-policy',
    'cross-origin-embedder-policy', 'cross-origin-resource-policy',
}

def build_request_headers(target_url: str) -> dict:
    """クライアントリクエストから対象サーバーへ転送するヘッダーを構築する"""
    headers = {}
    for key, value in request.headers:
        if key.lower() not in SKIP_REQUEST_HEADERS:
            headers[key] = value
    # Hostを対象URLのものに設定
    parsed = urlparse(target_url)
    headers['Host'] = parsed.netloc
    # Refererを書き換え
    if 'Referer' in headers:
        headers['Referer'] = target_url
    # User-Agentがない場合はデフォルト値を設定
    if 'User-Agent' not in headers:
        headers['User-Agent'] = DEFAULT_USER_AGENT
    # Accept関連ヘッダーを追加
    headers.setdefault('Accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8')
    headers.setdefault('Accept-Language', 'ja,en-US;q=0.9,en;q=0.8')
    return headers

def build_response_headers(resp_headers: dict, target_url: str) -> list:
    """対象サーバーのレスポンスヘッダーからクライアントへ転送するヘッダーを構築する"""
    headers = []
    for key, value in resp_headers.items():
        if key.lower() not in SKIP_RESPONSE_HEADERS:
            # Set-CookieのDomainやPathを書き換え
            if key.lower() == 'set-cookie':
                value = rewrite_set_cookie(value)
            # Locationヘッダーをプロキシ経由に変更
            elif key.lower() == 'location':
                abs_url = urljoin(target_url, value)
                value = proxy_url(abs_url)
            headers.append((key, value))
    return headers

def rewrite_set_cookie(cookie_str: str) -> str:
    """Set-CookieヘッダーからDomain/Secure/SameSite属性を除去する"""
    parts = cookie_str.split(';')
    new_parts = []
    for part in parts:
        stripped = part.strip().lower()
        if stripped.startswith('domain='):
            continue
        if stripped.startswith('secure'):
            continue
        if stripped.startswith('samesite'):
            new_parts.append(' SameSite=Lax')
            continue
        if stripped.startswith('path='):
            new_parts.append(' Path=/')
            continue
        new_parts.append(part)
    return ';'.join(new_parts)

# --- コンテンツ書き換え ---

def rewrite_html(html: str, base_url: str) -> str:
    """HTMLの<head>にフックスクリプトを注入する"""
    origin = get_origin(base_url)

    # フックスクリプトを<head>の先頭または<html>の直後に注入
    inject_script = (
        f'<script data-proxy="true">'
        f'window.__PROXY_PREFIX__="/p/";'
        f'window.__PROXY_BASE__="{base_url}";'
        f'window.__PROXY_ORIGIN__="{origin}";'
        f'</script>'
        f'<script data-proxy="true" src="/static/inject.js"></script>'
    )

    # <head> タグの直後に挿入
    head_pattern = re.compile(r'(<head[^>]*>)', re.IGNORECASE)
    if head_pattern.search(html):
        html = head_pattern.sub(r'\1' + inject_script, html, count=1)
    else:
        # <head>がない場合は<html>の直後に挿入
        html_pattern = re.compile(r'(<html[^>]*>)', re.IGNORECASE)
        if html_pattern.search(html):
            html = html_pattern.sub(r'\1<head>' + inject_script + '</head>', html, count=1)
        else:
            # どちらもない場合は先頭に追加
            html = inject_script + html

    return html

def rewrite_css(css: str, base_url: str) -> str:
    """CSS内のurl(...)を書き換える"""
    def replace_css_url(m):
        url = m.group(1).strip('\'"')
        if url.startswith('data:') or url.startswith('#'):
            return m.group(0)
        abs_url = urljoin(base_url, url)
        return f'url("{proxy_url(abs_url)}")'

    return re.sub(r'url\(([^)]+)\)', replace_css_url, css)

# --- ルーティング ---

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/p/<path:encoded_url>', methods=['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD'])
def proxy(encoded_url):
    """メインプロキシエンドポイント"""
    try:
        target_url = decode_url(encoded_url)
    except Exception:
        return 'URLのデコードに失敗しました', 400

    if not target_url.startswith(('http://', 'https://')):
        return '無効なURLです', 400

    # クエリパラメータを引き継ぐ
    if request.query_string:
        separator = '&' if '?' in target_url else '?'
        target_url += separator + request.query_string.decode('utf-8')

    try:
        # リクエストヘッダーを構築
        headers = build_request_headers(target_url)

        # リクエストボディの取得
        data = request.get_data() if request.method in ('POST', 'PUT', 'PATCH') else None

        # 対象サーバーへリクエスト
        resp = http_requests.request(
            method=request.method,
            url=target_url,
            headers=headers,
            data=data,
            cookies=request.cookies,
            allow_redirects=False,
            stream=True,
            timeout=30,
            verify=False,
        )

    except http_requests.exceptions.Timeout:
        return 'リクエストがタイムアウトしました', 504
    except http_requests.exceptions.ConnectionError:
        return '接続に失敗しました', 502
    except Exception as e:
        return f'リクエストエラー: {e}', 500

    content_type = resp.headers.get('Content-Type', '')

    # リダイレクトの処理
    if resp.status_code in (301, 302, 303, 307, 308):
        location = resp.headers.get('Location', '')
        if location:
            abs_location = urljoin(target_url, location)
            response_headers = build_response_headers(resp.headers, target_url)
            # Locationは既にbuild_response_headersで書き換え済み
            return Response(
                status=resp.status_code,
                headers=response_headers,
            )

    # レスポンスヘッダーの構築
    response_headers = build_response_headers(resp.headers, target_url)

    # HTMLの場合: フックスクリプトを注入
    if 'text/html' in content_type:
        body = resp.content.decode(resp.apparent_encoding or 'utf-8', errors='replace')
        body = rewrite_html(body, resp.url)
        return Response(body, status=resp.status_code, headers=response_headers, content_type=content_type)

    # CSSの場合: url()を書き換え
    if 'text/css' in content_type:
        body = resp.content.decode(resp.apparent_encoding or 'utf-8', errors='replace')
        body = rewrite_css(body, resp.url)
        return Response(body, status=resp.status_code, headers=response_headers, content_type=content_type)

    # その他 (JS, 画像, フォントなど): そのままストリーミング
    def generate():
        for chunk in resp.iter_content(chunk_size=8192):
            yield chunk

    return Response(generate(), status=resp.status_code, headers=response_headers, content_type=content_type)

# --- 互換性用レガシーエンドポイント ---

@app.route('/proxy')
def proxy_legacy():
    """旧エンドポイントとの互換性"""
    raw_url = request.args.get('url', '')
    if not raw_url:
        return 'URLが指定されていません', 400
    if raw_url.startswith('http'):
        return Response(status=302, headers={'Location': proxy_url(raw_url)})
    else:
        try:
            target = decode_url(raw_url)
            return Response(status=302, headers={'Location': proxy_url(target)})
        except Exception:
            return 'URLのデコードに失敗しました', 400

# --- サーバー起動 ---

def run():
    app.run(host='0.0.0.0', port=8080)

def keep_alive():
    t = Thread(target=run)
    t.start()
