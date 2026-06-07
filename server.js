import express from "express"

const app = express()
const PORT = process.env.PORT || 3001

// ─── Config ───────────────────────────────────────────────
const ENC_DEC_API = "https://enc-dec.app/api"
const FLUX_API = "https://stream.nflixmovies.app"

// ─── VidLink Scraper ──────────────────────────────────────
async function scrapeVidlink(type, id, season, episode) {
  // Step 1: encrypt TMDB ID
  const encRes = await fetch(
    `${ENC_DEC_API}/enc-vidlink?text=${encodeURIComponent(String(id))}`,
    { headers: { "User-Agent": "Mozilla/5.0 (compatible; Render)" } }
  )
  if (!encRes.ok) throw new Error("Encryption failed")
  const encData = await encRes.json()
  const encoded = encData?.result
  if (!encoded) throw new Error("No encoded result")

  // Step 2: call vidlink API
  const apiUrl = type === "tv"
    ? `https://vidlink.pro/api/b/tv/${encoded}/${season || "1"}/${episode || "1"}?multiLang=0`
    : `https://vidlink.pro/api/b/movie/${encoded}?multiLang=0`

  const apiRes = await fetch(apiUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "Referer": "https://vidlink.pro",
      "Origin": "https://vidlink.pro",
    },
  })
  if (!apiRes.ok) throw new Error(`VidLink API returned ${apiRes.status}`)
  const data = await apiRes.json()

  const streams = []
  if (data?.stream?.playlist) {
    streams.push({
      url: data.stream.playlist,
      type: data.stream.type || "hls",
      source: "vidlink",
      label: "VidLink",
      referer: "https://videostr.net",
      origin: "https://videostr.net",
      captions: data.stream.captions || [],
    })
  }
  return streams
}

// ─── FluxTV Scraper ──────────────────────────────────────
async function scrapeFluxTV(type, id, season, episode) {
  const endpoint = type === "tv"
    ? `${FLUX_API}/tv?id=${id}&season=${season || "1"}&episode=${episode || "1"}`
    : `${FLUX_API}/movie?id=${id}`

  const res = await fetch(endpoint, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "Origin": "https://player.fluxtv.cc",
      "Referer": "https://player.fluxtv.cc/",
    },
  })
  if (!res.ok) throw new Error(`FluxTV API returned ${res.status}`)

  const text = await res.text()
  const streams = []

  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue
    try {
      const data = JSON.parse(line.slice(6))
      if (data.type === "source" && data.source?.url) {
        const url = data.source.url
        const ref = data.source.referer || ""
        const ori = data.source.origin || ""
        const label = data.source.label || data.source.source || "FluxTV"
        const srcName = data.source.source || ""

        // Parse MovSrc-style JSON playlists
        if (url.includes("/playlist/")) {
          try {
            const plRes = await fetch(url, {
              headers: {
                "User-Agent": "Mozilla/5.0",
                "Referer": ref || "https://vidrock.net/",
                "Origin": ori || "https://vidrock.net",
              },
            })
            if (plRes.ok) {
              const ct = plRes.headers.get("content-type") || ""
              if (ct.includes("json")) {
                const qualities = await plRes.json()
                if (Array.isArray(qualities)) {
                  for (const q of qualities) {
                    streams.push({
                      url: q.url,
                      type: "mp4",
                      source: srcName,
                      label: `${label} ${q.resolution || "HD"}p`,
                      referer: ref,
                      origin: ori,
                      quality: q.resolution || 0,
                    })
                  }
                  continue
                }
              }
            }
          } catch {}
        }

        streams.push({
          url,
          type: url.includes(".mp4") ? "mp4" : "hls",
          source: srcName,
          label,
          referer: ref,
          origin: ori,
        })
      }
    } catch {}
  }

  streams.sort((a, b) => {
    const qA = a.quality || 0
    const qB = b.quality || 0
    if (qB !== qA) return qB - qA
    return a.type === "mp4" ? -1 : 1
  })

  return streams
}

// ─── Routes ──────────────────────────────────────────────

// Health check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() })
})

// Scrape endpoint
app.get("/api/scrape", async (req, res) => {
  const { source, type, id, season, episode } = req.query

  if (!source || !type || !id) {
    return res.status(400).json({ error: "Missing required params: source, type, id" })
  }

  try {
    let streams = []

    if (source === "fluxtv") {
      streams = await scrapeFluxTV(type, id, season, episode)
    } else if (source === "vidlink") {
      streams = await scrapeVidlink(type, id, season, episode)
    } else {
      return res.status(400).json({ error: "Unknown source: " + source })
    }

    if (streams.length === 0) {
      return res.status(404).json({ error: "No streams found", streams: [] })
    }

    res.json({ streams })
  } catch (err) {
    res.status(502).json({ error: err.message })
  }
})

// Stream proxy — forwards video streams with proper headers + CORS
// No 100MB limit (unlike Cloudflare Workers free tier)
app.get("/api/proxy", async (req, res) => {
  const targetUrl = req.query.url
  const referer = req.query.referer || ""
  const origin = req.query.origin || referer

  if (!targetUrl) {
    return res.status(400).send("Missing url parameter")
  }

  try {
    new URL(targetUrl)
  } catch {
    return res.status(400).send("Invalid URL")
  }

  // Default to first 2MB if browser doesn't send Range (avoids buffering 872MB)
  const range = req.headers.range || "bytes=0-2097151"
  const accept = req.headers.accept || "*/*"

  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    Accept: accept,
    "Accept-Language": "en-US,en;q=0.9",
  }
  if (referer) headers["Referer"] = referer
  if (origin) headers["Origin"] = origin
  if (range) headers["Range"] = range

  try {
    const response = await fetch(targetUrl, { headers })

    // Forward response headers (with CORS additions)
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    }

    // Copy relevant headers from origin response
    const forwardHeaders = [
      "content-type", "content-length", "content-range",
      "accept-ranges", "etag", "last-modified",
      "cache-control", "expires",
    ]
    for (const key of forwardHeaders) {
      const val = response.headers.get(key)
      if (val) corsHeaders[key] = val
    }

    // Remove content-disposition (would force download)
    delete corsHeaders["content-disposition"]

    res.status(response.status)
    res.set(corsHeaders)

    // Stream the response body chunk by chunk (no buffering)
    const reader = response.body.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        res.write(value)
      }
    } finally {
      reader.releaseLock()
    }
    res.end()
  } catch (err) {
    res.status(502).send("Proxy error: " + err.message)
  }
})

app.listen(PORT, () => {
  console.log(`cinrift-api running on port ${PORT}`)
})
