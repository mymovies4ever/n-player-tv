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

class ChannelRepository(private val context: Context) {

    private val json = Json {
        ignoreUnknownKeys = true
        isLenient = true
    }

    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(12, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .build()

    var allChannels: List<Channel> = emptyList()
        private set

    val categories: MutableList<String> = mutableListOf("All Channels")
    val languages: MutableList<String> = mutableListOf("All Languages")

    suspend fun initialize(): List<Channel> = withContext(Dispatchers.IO) {
        if (allChannels.isNotEmpty()) return@withContext allChannels

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
        allChannels
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
