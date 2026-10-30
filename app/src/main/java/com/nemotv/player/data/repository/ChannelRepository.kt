package com.nemotv.player.data.repository

import android.content.Context
import com.nemotv.player.data.model.Channel
import com.nemotv.player.data.model.EpgProgram
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import okhttp3.Request
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale
import java.util.concurrent.TimeUnit
import kotlin.math.abs

import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.serialization.encodeToString

class ChannelRepository(private val context: Context) {

    private val json = Json {
        ignoreUnknownKeys = true
        isLenient = true
    }

    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .build()

    companion object {
        const val LIVE_PLAYLIST_URL = "https://m3u8playlistterminal-jiotv.lovable.app/api/playlist"
        private const val CACHE_FILE_NAME = "channels_cache.json"
    }

    var allChannels: List<Channel> = emptyList()
        private set

    val categories: MutableList<String> = mutableListOf("All Channels")
    val languages: MutableList<String> = mutableListOf("All Languages")

    var onChannelsUpdated: (() -> Unit)? = null

    suspend fun initialize(): List<Channel> = withContext(Dispatchers.IO) {
        if (allChannels.isNotEmpty()) return@withContext allChannels

        // 1. Try loading cached channels if present
        val cached = loadFromDiskCache()
        if (cached != null && cached.isNotEmpty()) {
            allChannels = cached
            extractFilters()
        } else {
            // 2. Fall back to bundled assets
            try {
                val assetStream = context.assets.open("channels.json")
                val content = assetStream.bufferedReader().use { it.readText() }
                val list = json.decodeFromString<List<Channel>>(content)
                allChannels = list.mapIndexed { idx, ch ->
                    ch.copy(channelNumber = idx + 1)
                }
                extractFilters()
            } catch (e: Exception) {
                e.printStackTrace()
            }
        }

        // 3. Asynchronously trigger fresh live token fetch
        refreshLiveTokensAsync()

        allChannels
    }

    fun refreshLiveTokensAsync() {
        CoroutineScope(Dispatchers.IO).launch {
            refreshLiveTokens()
        }
    }

    suspend fun refreshLiveTokens(): Boolean = withContext(Dispatchers.IO) {
        try {
            val req = Request.Builder()
                .url("$LIVE_PLAYLIST_URL?t=${System.currentTimeMillis()}")
                .header("User-Agent", "NemoTV/2.0 (Android)")
                .build()

            val response = httpClient.newCall(req).execute()
            if (!response.isSuccessful) return@withContext false

            val m3uText = response.body?.string() ?: return@withContext false
            val liveSources = parseM3uLiveSources(m3uText)
            if (liveSources.isEmpty()) return@withContext false

            val updated = allChannels.map { ch ->
                val normName = ch.name.lowercase(Locale.ROOT).replace(Regex("[^a-z0-9]"), "")
                val freshSource = liveSources[ch.tvgId] ?: liveSources[normName]

                if (freshSource != null) {
                    val remaining = ch.sources.filter { it.url != freshSource.url }
                    ch.copy(sources = listOf(freshSource) + remaining)
                } else {
                    ch
                }
            }

            allChannels = updated
            saveToDiskCache(updated)
            extractFilters()
            withContext(Dispatchers.Main) {
                onChannelsUpdated?.invoke()
            }
            true
        } catch (e: Exception) {
            e.printStackTrace()
            false
        }
    }

    private fun parseM3uLiveSources(content: String): Map<String, com.nemotv.player.data.model.StreamSource> {
        val map = mutableMapOf<String, com.nemotv.player.data.model.StreamSource>()
        val lines = content.split('\n')

        var curTvgId: String? = null
        var curName: String? = null
        var curLicenseKey: String? = null
        var curCookie: String? = null
        var curUa: String = "Premium Plugx"

        val tvgIdRegex = Regex("""tvg-id="([^"]+)"""")
        val tvgNameRegex = Regex("""tvg-name="([^"]+)"""")

        for (rawLine in lines) {
            val line = rawLine.trim()
            if (line.isEmpty()) continue

            if (line.startsWith("#EXTINF:")) {
                curLicenseKey = null
                curCookie = null
                curUa = "Premium Plugx"

                val idMatch = tvgIdRegex.find(line)
                val nameMatch = tvgNameRegex.find(line)
                val commaIdx = line.lastIndexOf(',')
                val title = if (commaIdx != -1) line.substring(commaIdx + 1).trim() else ""

                curTvgId = idMatch?.groupValues?.get(1)?.trim()
                curName = (nameMatch?.groupValues?.get(1)?.trim() ?: title).lowercase(Locale.ROOT)
            } else if (line.startsWith("#KODIPROP:inputstream.adaptive.license_key=")) {
                curLicenseKey = line.substringAfter('=').trim()
            } else if (line.startsWith("#EXTVLCOPT:http-user-agent=")) {
                curUa = line.substringAfter('=').trim()
            } else if (line.startsWith("#EXTHTTP:")) {
                try {
                    val jsonPart = line.substring(9).trim()
                    val cookieMatch = Regex(""""cookie"\s*:\s*"([^"]+)"""").find(jsonPart)
                    curCookie = cookieMatch?.groupValues?.get(1)
                } catch (_: Exception) {}
            } else if (!line.startsWith("#") && line.startsWith("http")) {
                val headers = mutableMapOf("User-Agent" to curUa)
                if (!curCookie.isNullOrBlank()) {
                    headers["Cookie"] = curCookie
                }

                val drmConfig = if (!curLicenseKey.isNullOrBlank()) {
                    com.nemotv.player.data.model.DrmConfig(type = "clearkey", key = curLicenseKey)
                } else null

                val manifestType = if (line.contains(".mpd", ignoreCase = true)) "mpd" else "hls"

                val source = com.nemotv.player.data.model.StreamSource(
                    url = line,
                    manifestType = manifestType,
                    drm = drmConfig,
                    headers = headers,
                    playlistName = "Live Terminal JioTV"
                )

                if (!curTvgId.isNullOrBlank()) {
                    map[curTvgId] = source
                }
                if (!curName.isNullOrBlank()) {
                    val norm = curName.replace(Regex("[^a-z0-9]"), "")
                    map[norm] = source
                }
            }
        }
        return map
    }

    private fun loadFromDiskCache(): List<Channel>? {
        return try {
            val file = File(context.filesDir, CACHE_FILE_NAME)
            if (!file.exists()) return null
            val text = file.readText()
            json.decodeFromString<List<Channel>>(text)
        } catch (_: Exception) {
            null
        }
    }

    private fun saveToDiskCache(channels: List<Channel>) {
        try {
            val file = File(context.filesDir, CACHE_FILE_NAME)
            file.writeText(json.encodeToString<List<Channel>>(channels))
        } catch (_: Exception) {}
    }

    private fun extractFilters() {
        val catSet = allChannels.mapNotNull { it.category }.filter { it.isNotBlank() && it != "Movies" }.toSet()
        val priorityCategories = listOf(
            "All Channels", "Bigg Boss 24/7", "Sports", "Web Series",
            "Entertainment", "News", "Kids", "Infotainment", "Music", "Regional", "Devotional"
        )
        categories.clear()
        categories.addAll(priorityCategories.filter { it == "All Channels" || catSet.contains(it) })
        catSet.filter { !priorityCategories.contains(it) }.sorted().forEach { categories.add(it) }

        val langSet = allChannels.mapNotNull { it.language }.filter { it.isNotBlank() }.toSet()
        val priorityLanguages = listOf(
            "All Languages", "Malayalam", "Tamil", "Hindi", "Telugu",
            "Kannada", "English", "Bengali", "Marathi", "Punjabi", "General"
        )
        languages.clear()
        languages.addAll(priorityLanguages.filter { it == "All Languages" || langSet.contains(it) })
        langSet.filter { !priorityLanguages.contains(it) }.sorted().forEach { languages.add(it) }
    }

    fun getFilteredChannels(
        category: String = "All Channels",
        language: String = "All Languages",
        query: String = "",
        section: String = "live"
    ): List<Channel> {
        var list = allChannels.filter { if (section == "vod") it.isMovie else !it.isMovie }

        if (category != "All Channels" && category != "All Movies") {
            list = list.filter { it.category.equals(category, ignoreCase = true) }
        }

        if (language != "All Languages") {
            list = list.filter { (it.language ?: "General").equals(language, ignoreCase = true) }
        }

        if (query.isNotBlank()) {
            val q = query.trim().lowercase(Locale.ROOT)
            list = list.filter {
                it.name.lowercase(Locale.ROOT).contains(q) ||
                (it.category?.lowercase(Locale.ROOT)?.contains(q) == true) ||
                (it.language?.lowercase(Locale.ROOT)?.contains(q) == true)
            }
        }

        return list
    }

    fun getEpgProgram(channel: Channel): EpgProgram {
        val cal = Calendar.getInstance()
        val hour = cal.get(Calendar.HOUR_OF_DAY)
        val minute = cal.get(Calendar.MINUTE)
        val block = hour * 2 + if (minute >= 30) 1 else 0

        val hash = abs(channel.name.hashCode())
        val liveTitles = getCategoryShows(channel.category ?: "Entertainment", channel.language ?: "General")
        val currentIdx = (block + (hash % liveTitles.size)) % liveTitles.size
        val nextIdx = (currentIdx + 1) % liveTitles.size

        val startMin = if (minute >= 30) 30 else 0
        val endCal = (cal.clone() as Calendar).apply {
            set(Calendar.MINUTE, startMin)
            add(Calendar.MINUTE, 30)
        }

        val df = SimpleDateFormat("h:mm a", Locale.getDefault())
        val curCal = (cal.clone() as Calendar).apply { set(Calendar.MINUTE, startMin) }
        val timeSlot = "${df.format(curCal.time)} - ${df.format(endCal.time)}"

        val elapsed = (minute - startMin).toFloat()
        val progress = (elapsed / 30f).coerceIn(0.1f, 0.95f)

        return EpgProgram(
            currentTitle = liveTitles[currentIdx],
            timeSlot = timeSlot,
            progressPercent = progress,
            nextTitle = liveTitles[nextIdx]
        )
    }

    private fun getCategoryShows(category: String, language: String): List<String> {
        val cat = category.lowercase(Locale.ROOT)
        return when {
            cat.contains("bigg boss") -> listOf(
                "Bigg Boss 24/7 Live Stream", "Morning Wake Up Call & Task", "Nomination Room Live",
                "Luxury Budget Challenge", "Confession Room Uncut", "Late Night House Talks"
            )
            cat.contains("sport") || cat.contains("cricket") -> listOf(
                "Live Match Centre", "Pre-Match Studio Analysis", "Championship Highlights",
                "World Tour Spotlight", "Post-Match Wrap & Presser", "Super 10 Iconic Moments"
            )
            cat.contains("news") -> listOf(
                "Prime Time Live News", "Headlines at This Hour", "Special Debate & Focus",
                "Global Market & Stock Watch", "Special Ground Report", "Non-Stop 100 Express"
            )
            cat.contains("music") -> listOf(
                "Top 20 Chartbusters", "Morning Melodies", "Retro Classics 90s",
                "Non-Stop Beat Drop", "Trending Viral Hits", "Artist Spotlight & Duets"
            )
            cat.contains("movie") || cat.contains("cinema") -> listOf(
                "Matinee Blockbuster", "Prime Time Mega Movie", "Late Night Action Thriller",
                "Classic Cinema Hall", "Superhit Afternoon Double", "Golden Era Drama"
            )
            else -> listOf(
                "Special Feature Broadcast", "Popular Series Episode", "Prime Time Drama",
                "Superhit Daily Broadcast", "Mega Special Showcase", "Celebrity Talk & Highlights"
            )
        }
    }
}
