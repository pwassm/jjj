#!/usr/bin/env python3
"""
(dev0647) TLS-impersonated single-URL fetcher for the proxy's Instagram PHOTO path.

Why this exists: reels download fine on VPN/datacenter IPs because yt-dlp's bundled
curl_cffi gives them a real-Chrome TLS handshake (JA3), so IG's IP-reputation wall
lets them through. Photos have NO yt-dlp path (yt-dlp fetches zero IG still images),
so the proxy scrapes the /p/ inline JSON and downloads the CDN media with Node's
https.get -- whose TLS fingerprint IG flags on those IPs, walling photos cookielessly.

This helper fetches ONE url with the SAME curl_cffi impersonation reels enjoy and writes
the raw bytes to a file, so the proxy can reuse it for both the /p/ page HTML and the
fbcdn/scontent media. Purely cookieless -- no Firefox cookies, the IG account is never
touched. Exit 0 on a 200 with a non-empty body, else 1 (proxy falls through to its
existing empty-result handling).

Usage:  python ig_impersonate_fetch.py <url> <outfile> [referer] [accept] [ua]
Stdout: the numeric HTTP status (or "ERR <msg>" on a transport failure).
"""
import sys

def main():
    if len(sys.argv) < 3:
        print("ERR usage: <url> <outfile> [referer] [accept] [ua]")
        return 2
    url, outfile = sys.argv[1], sys.argv[2]
    referer = sys.argv[3] if len(sys.argv) > 3 else ""
    accept  = sys.argv[4] if len(sys.argv) > 4 else "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"
    ua      = sys.argv[5] if len(sys.argv) > 5 else ""
    try:
        from curl_cffi import requests
    except Exception as e:  # not installed -> proxy keeps working via its Node paths
        print("ERR curl_cffi import: " + str(e))
        return 3
    headers = {
        "Accept": accept,
        "Accept-Language": "en-US,en;q=0.9",
    }
    if referer:
        headers["Referer"] = referer
    if ua:  # keep the short UA the /embed/ page needs, while still impersonating Chrome's TLS
        headers["User-Agent"] = ua
    try:
        # impersonate="chrome" aliases to a current Chrome fingerprint (TLS + HTTP2 + headers).
        r = requests.get(url, headers=headers, impersonate="chrome",
                         timeout=25, allow_redirects=True)
    except Exception as e:
        print("ERR fetch: " + str(e))
        return 1
    body = r.content or b""
    try:
        with open(outfile, "wb") as f:
            f.write(body)
    except Exception as e:
        print("ERR write: " + str(e))
        return 1
    print(str(r.status_code))
    return 0 if (r.status_code == 200 and len(body) > 0) else 1

if __name__ == "__main__":
    sys.exit(main())
