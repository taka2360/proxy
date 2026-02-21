// === Proxy Client-Side Hook Script ===
// ブラウザ内の全ネットワークリクエストとナビゲーションをインターセプトし
// プロキシ経由のURLに書き換えるスクリプト

(function () {
  "use strict";

  const PREFIX = window.__PROXY_PREFIX__ || "/p/";
  const BASE_URL = window.__PROXY_BASE__ || "";
  const ORIGIN = window.__PROXY_ORIGIN__ || "";

  // 再入防止フラグ (MutationObserverの無限ループ防止)
  let _rewriting = false;

  // --- ユーティリティ ---

  // Base64URLエンコード
  function encodeUrl(url) {
    try {
      const encoded = btoa(unescape(encodeURIComponent(url)));
      return encoded.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    } catch (e) {
      return btoa(url).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    }
  }

  // 絶対URLに変換
  function toAbsolute(url) {
    if (!url) return url;
    url = url.trim();
    if (url.startsWith("data:") || url.startsWith("blob:") || url.startsWith("javascript:") || url.startsWith("#") || url.startsWith("about:") || url.startsWith("mailto:")) {
      return url;
    }
    if (url.startsWith("//")) {
      try { return new URL(ORIGIN).protocol + url; } catch (e) { return "https:" + url; }
    }
    if (url.startsWith("/") && !url.startsWith(PREFIX)) {
      return ORIGIN + url;
    }
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      try {
        return new URL(url, BASE_URL).href;
      } catch (e) {
        return url;
      }
    }
    return url;
  }

  // URLがプロキシ対象かどうか判定
  function shouldProxy(url) {
    if (!url || typeof url !== "string") return false;
    url = url.trim();
    if (!url) return false;
    if (url.startsWith(PREFIX)) return false;
    if (url.startsWith("/p/")) return false;
    if (url.startsWith("/static/")) return false;
    if (url.startsWith("data:") || url.startsWith("blob:") || url.startsWith("javascript:") || url.startsWith("#") || url.startsWith("about:") || url.startsWith("mailto:")) return false;
    // 自ホストへのURLはプロキシ不要
    try {
      if (url.startsWith("http")) {
        const u = new URL(url);
        if (u.host === location.host) return false;
      }
    } catch (e) {}
    return true;
  }

  // URLをプロキシURL形式に変換
  function proxyUrl(url) {
    if (!shouldProxy(url)) return url;
    const absolute = toAbsolute(url);
    if (!absolute || (!absolute.startsWith("http://") && !absolute.startsWith("https://"))) return url;
    return PREFIX + encodeUrl(absolute);
  }

  // --- fetch フック ---

  const originalFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      if (typeof input === "string") {
        input = proxyUrl(input);
      } else if (input instanceof Request) {
        const newUrl = proxyUrl(input.url);
        if (newUrl !== input.url) {
          input = new Request(newUrl, input);
        }
      } else if (input instanceof URL) {
        input = proxyUrl(input.href);
      }
    } catch (e) {}
    return originalFetch.call(this, input, init);
  };

  // --- XMLHttpRequest フック ---

  const originalXHROpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...args) {
    try {
      url = proxyUrl(url instanceof URL ? url.href : String(url));
    } catch (e) {}
    return originalXHROpen.call(this, method, url, ...args);
  };

  // --- window.open フック ---

  const originalWindowOpen = window.open;
  window.open = function (url, ...args) {
    try {
      if (url) url = proxyUrl(String(url));
    } catch (e) {}
    return originalWindowOpen.call(this, url, ...args);
  };

  // --- History API フック ---

  const originalPushState = History.prototype.pushState;
  const originalReplaceState = History.prototype.replaceState;

  History.prototype.pushState = function (state, title, url) {
    if (url) {
      try { url = proxyUrl(String(url)); } catch (e) {}
    }
    return originalPushState.call(this, state, title, url);
  };

  History.prototype.replaceState = function (state, title, url) {
    if (url) {
      try { url = proxyUrl(String(url)); } catch (e) {}
    }
    return originalReplaceState.call(this, state, title, url);
  };

  // --- Worker / SharedWorker フック ---

  if (typeof Worker !== "undefined") {
    const OriginalWorker = Worker;
    window.Worker = function (url, options) {
      try { url = proxyUrl(String(url)); } catch (e) {}
      return new OriginalWorker(url, options);
    };
    window.Worker.prototype = OriginalWorker.prototype;
  }

  if (typeof SharedWorker !== "undefined") {
    const OriginalSharedWorker = SharedWorker;
    window.SharedWorker = function (url, options) {
      try { url = proxyUrl(String(url)); } catch (e) {}
      return new OriginalSharedWorker(url, options);
    };
    window.SharedWorker.prototype = OriginalSharedWorker.prototype;
  }

  // --- EventSource フック ---

  if (typeof EventSource !== "undefined") {
    const OriginalEventSource = EventSource;
    window.EventSource = function (url, config) {
      try { url = proxyUrl(String(url)); } catch (e) {}
      return new OriginalEventSource(url, config);
    };
    window.EventSource.prototype = OriginalEventSource.prototype;
  }

  // --- Element.setAttribute フック ---

  const URL_ATTRS = new Set(["src", "href", "action", "poster", "data", "srcset", "formaction"]);
  const originalSetAttribute = Element.prototype.setAttribute;

  Element.prototype.setAttribute = function (name, value) {
    // 再入防止: _rewriting中はフックせずそのまま設定
    if (!_rewriting && URL_ATTRS.has(name.toLowerCase()) && typeof value === "string") {
      try {
        if (name.toLowerCase() === "srcset") {
          value = rewriteSrcset(value);
        } else {
          value = proxyUrl(value);
        }
      } catch (e) {}
    }
    return originalSetAttribute.call(this, name, value);
  };

  // srcset属性の書き換え
  function rewriteSrcset(srcset) {
    return srcset.split(",").map(function (entry) {
      var parts = entry.trim().split(/\s+/);
      if (parts[0]) parts[0] = proxyUrl(parts[0]);
      return parts.join(" ");
    }).join(", ");
  }

  // --- DOM Property フック ---

  function hookProperty(proto, prop) {
    var descriptor = Object.getOwnPropertyDescriptor(proto, prop);
    if (!descriptor || !descriptor.set) return;
    var originalSet = descriptor.set;
    var originalGet = descriptor.get;
    Object.defineProperty(proto, prop, {
      get: originalGet,
      set: function (value) {
        if (!_rewriting && typeof value === "string") {
          try { value = proxyUrl(value); } catch (e) {}
        }
        return originalSet.call(this, value);
      },
      configurable: true,
      enumerable: true,
    });
  }

  try { hookProperty(HTMLAnchorElement.prototype, "href"); } catch (e) {}
  try { hookProperty(HTMLImageElement.prototype, "src"); } catch (e) {}
  try { hookProperty(HTMLScriptElement.prototype, "src"); } catch (e) {}
  try { hookProperty(HTMLLinkElement.prototype, "href"); } catch (e) {}
  try { hookProperty(HTMLIFrameElement.prototype, "src"); } catch (e) {}
  try { hookProperty(HTMLSourceElement.prototype, "src"); } catch (e) {}
  try { hookProperty(HTMLMediaElement.prototype, "src"); } catch (e) {}
  try { hookProperty(HTMLFormElement.prototype, "action"); } catch (e) {}
  try { hookProperty(HTMLInputElement.prototype, "formAction"); } catch (e) {}
  try { hookProperty(HTMLButtonElement.prototype, "formAction"); } catch (e) {}

  // --- document.write / writeln フック ---

  const originalDocWrite = document.write;
  const originalDocWriteln = document.writeln;

  document.write = function () {
    var args = Array.from(arguments).map(function (arg) {
      return typeof arg === "string" ? rewriteInlineHtml(arg) : arg;
    });
    return originalDocWrite.apply(this, args);
  };

  document.writeln = function () {
    var args = Array.from(arguments).map(function (arg) {
      return typeof arg === "string" ? rewriteInlineHtml(arg) : arg;
    });
    return originalDocWriteln.apply(this, args);
  };

  function rewriteInlineHtml(html) {
    return html.replace(/(src|href|action|poster|data)\s*=\s*["']([^"']+)["']/gi, function (match, attr, url) {
      return attr + '="' + proxyUrl(url) + '"';
    });
  }

  // --- MutationObserver: 動的DOM変更の監視 ---

  // 単一ノードの属性を書き換え (_rewritingフラグで無限ループを防止)
  function rewriteNodeAttrs(node) {
    if (node.nodeType !== 1) return;
    // 自身のスクリプトはスキップ
    if (node.getAttribute && node.getAttribute("data-proxy") === "true") return;

    var attrs = [
      ["src", false],
      ["href", false],
      ["action", false],
      ["poster", false],
      ["data", false],
      ["srcset", true],
    ];

    for (var i = 0; i < attrs.length; i++) {
      var attrName = attrs[i][0];
      var isSrcset = attrs[i][1];
      if (node.hasAttribute && node.hasAttribute(attrName)) {
        var val = node.getAttribute(attrName);
        if (isSrcset) {
          var newVal = rewriteSrcset(val);
          if (newVal !== val) {
            originalSetAttribute.call(node, attrName, newVal);
          }
        } else if (shouldProxy(val)) {
          originalSetAttribute.call(node, attrName, proxyUrl(val));
        }
      }
    }

    // style属性内のurl()
    if (node.hasAttribute && node.hasAttribute("style")) {
      var style = node.getAttribute("style");
      if (style && style.indexOf("url(") !== -1) {
        var rewritten = style.replace(/url\(["']?([^)"']+)["']?\)/g, function (match, url) {
          if (url.startsWith("data:")) return match;
          return 'url("' + proxyUrl(url) + '")';
        });
        if (rewritten !== style) {
          originalSetAttribute.call(node, "style", rewritten);
        }
      }
    }
  }

  // 追加されたノードをバッチ処理 (パフォーマンス対策)
  var pendingNodes = [];
  var batchScheduled = false;

  function scheduleBatch() {
    if (batchScheduled) return;
    batchScheduled = true;
    // requestAnimationFrameでまとめて処理 (UIブロックを防止)
    requestAnimationFrame(function () {
      batchScheduled = false;
      if (pendingNodes.length === 0) return;
      var nodes = pendingNodes;
      pendingNodes = [];
      _rewriting = true;
      try {
        for (var i = 0; i < nodes.length; i++) {
          rewriteNodeAttrs(nodes[i]);
        }
      } finally {
        _rewriting = false;
      }
    });
  }

  var observer = new MutationObserver(function (mutations) {
    // 再入チェック: 自分の書き換えによるmutationは無視
    if (_rewriting) return;

    var nodesToProcess = [];

    for (var i = 0; i < mutations.length; i++) {
      var mutation = mutations[i];

      // 追加されたノード
      if (mutation.addedNodes) {
        for (var j = 0; j < mutation.addedNodes.length; j++) {
          var addedNode = mutation.addedNodes[j];
          if (addedNode.nodeType === 1) {
            nodesToProcess.push(addedNode);
            // 子要素も対象 (ただしquerySelectorAllは追加ノードのみ)
            if (addedNode.querySelectorAll) {
              var children = addedNode.querySelectorAll("*");
              for (var k = 0; k < children.length; k++) {
                nodesToProcess.push(children[k]);
              }
            }
          }
        }
      }

      // 属性変更
      if (mutation.type === "attributes" && mutation.target && mutation.target.nodeType === 1) {
        nodesToProcess.push(mutation.target);
      }
    }

    if (nodesToProcess.length > 0) {
      // 少量ならすぐ処理、大量ならバッチ
      if (nodesToProcess.length <= 50) {
        _rewriting = true;
        try {
          for (var n = 0; n < nodesToProcess.length; n++) {
            rewriteNodeAttrs(nodesToProcess[n]);
          }
        } finally {
          _rewriting = false;
        }
      } else {
        pendingNodes = pendingNodes.concat(nodesToProcess);
        scheduleBatch();
      }
    }
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["src", "href", "action", "poster", "data", "srcset", "formaction", "style"],
  });

  // 既存のDOM要素を書き換え
  function rewriteExistingDom() {
    _rewriting = true;
    try {
      var all = document.querySelectorAll("[src], [href], [action], [poster], [srcset], [style]");
      for (var i = 0; i < all.length; i++) {
        rewriteNodeAttrs(all[i]);
      }
    } finally {
      _rewriting = false;
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", rewriteExistingDom);
  } else {
    rewriteExistingDom();
  }

  // --- <a>要素のクリックイベントをキャプチャ ---

  document.addEventListener("click", function (e) {
    var target = e.target;
    while (target && target.tagName !== "A") {
      target = target.parentElement;
    }
    if (!target || !target.href) return;

    var href = target.getAttribute("href");
    if (!href || !shouldProxy(href)) return;

    e.preventDefault();
    window.location.href = proxyUrl(href);
  }, true);

  // --- フォーム送信のインターセプト ---

  document.addEventListener("submit", function (e) {
    var form = e.target;
    if (!form || form.tagName !== "FORM") return;

    var action = form.getAttribute("action");
    if (action && shouldProxy(action)) {
      _rewriting = true;
      originalSetAttribute.call(form, "action", proxyUrl(action));
      _rewriting = false;
    } else if (!action) {
      _rewriting = true;
      originalSetAttribute.call(form, "action", window.location.href);
      _rewriting = false;
    }
  }, true);

  // --- CSSStyleSheet insertRule フック ---

  if (typeof CSSStyleSheet !== "undefined" && CSSStyleSheet.prototype.insertRule) {
    var originalInsertRule = CSSStyleSheet.prototype.insertRule;
    CSSStyleSheet.prototype.insertRule = function (rule, index) {
      if (typeof rule === "string" && rule.indexOf("url(") !== -1) {
        rule = rule.replace(/url\(["']?([^)"']+)["']?\)/g, function (match, url) {
          if (url.startsWith("data:")) return match;
          return 'url("' + proxyUrl(url) + '")';
        });
      }
      return originalInsertRule.call(this, rule, index);
    };
  }

  // --- innerHTML フック (MutationObserverに任せ、手動処理は省略) ---
  // MutationObserverが既にchildList: trueで監視中なので
  // innerHTML経由のDOM変更も自動的にキャッチされる
  // → 手動でquerySelectorAll("*")する二重処理を排除

  console.log("[Proxy] Client-side hooks initialized");
})();
