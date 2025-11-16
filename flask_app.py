from flask import Flask, request, Response, render_template_string
import requests
from bs4 import BeautifulSoup
from urllib.parse import urljoin, unquote, urlparse
import base64
import re
from threading import Thread

app = Flask(__name__)

def encode_url(url: str) -> str:
    return base64.b64encode(url.encode('utf-8'), altchars=b'-:').decode()

def rewrite_url(attr_val: str, base_url: str) -> str:
    if not urlparse(attr_val).scheme:
        attr_val = urljoin(base_url, attr_val)
    return f"/proxy?url={encode_url(attr_val)}"

@app.route('/')
def index():
    return render_template_string('''
        <form action="/proxy" method="get">
            <input name="url" placeholder="https://example.com" size="50">
            <input type="submit" value="Fetch">
        </form>
    ''')

@app.route('/proxy')
def proxy():
    # URL取得（Base64またはそのまま）
    raw_url = request.args.get('url', '')
    target = raw_url if raw_url.startswith("http") else base64.b64decode(raw_url, altchars=b'-:').decode()

    if not target:
        return "URLが指定されていません", 400

    try:
        resp = requests.get(target)
    except Exception as e:
        return f"取得失敗: {e}", 500

    content_type = resp.headers.get('Content-Type', '')

    # HTML の場合
    if 'text/html' in content_type:
        soup = BeautifulSoup(resp.text, 'html.parser')
        base_url = resp.url

        tag_map = {
            'a': 'href',
            'img': 'src',
            'link': 'href',
            'script': 'src',
            'form': 'action'
        }

        for tag, attr in tag_map.items():
            for t in soup.find_all(tag):
                if t.has_attr(attr):
                    orig = t[attr].replace("\\", "/")
                    abs_url = urljoin(base_url, orig)
                    t[attr] = f"/proxy?url={encode_url(abs_url)}"
        
        for script in soup.find_all("script"):
            if script.string:
                original_js = script.string

                def replace_inline_js_url(m):
                    raw_url = m.group(1)
                    new_url = rewrite_url(raw_url, base_url)
                    return f'"{new_url}"'

                updated_js = re.sub(r'"(https?://[^"]+|/[^"]+)"', replace_inline_js_url, original_js)
                script.string.replace_with(updated_js)

        return Response(str(soup), content_type='text/html')

    # JavaScript の場合

        # 対象パターンを順次置換
    elif 'javascript' in content_type or target.endswith('.js'):
        js_code = resp.text
        base_url = resp.url
    
        # 1. "..." のURL置換
        js_code = re.sub(r'"(https?://[^"]+|/[^"]+)"',
                         lambda m: f'"{f"/proxy?url={encode_url(urljoin(base_url, m.group(1)))}"}"', js_code)
    
        # 2. '...' のURL置換（今回追加！）
        js_code = re.sub(r"'(https?://[^']+|/[^']+)'",
                         lambda m: f"'{f'/proxy?url={encode_url(urljoin(base_url, m.group(1)))}'}'", js_code)
    
        # 3. src= や href= の書き換え（安全策）
        js_code = re.sub(r"(src|href)\s*=\s*['\"](https?://[^'\"]+|/[^'\"]+)['\"]",
                         lambda m: f'{m.group(1)}="/proxy?url={encode_url(urljoin(base_url, m.group(2)))}"', js_code)
    
        # 4. <script src=...> タグの書き換え（HTMLとしてJS中にある場合）
        js_code = re.sub(r'<script\s+src=["\'](https?://[^"\']+|/[^"\']+)["\']>',
                         lambda m: f'<script src="/proxy?url={encode_url(urljoin(base_url, m.group(1)))}">', js_code)
    
        return Response(js_code, content_type='application/javascript')

    # その他（画像・CSSなど）
    return Response(resp.content, content_type=content_type)

def run():
    app.run(host='0.0.0.0', port=8080)

def keep_alive():
    t = Thread(target=run)
    t.start()