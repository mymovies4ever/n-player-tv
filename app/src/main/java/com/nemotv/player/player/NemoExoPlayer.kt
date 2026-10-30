package com.nemotv.player.player

import android.content.Context
import android.net.Uri
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.drm.DefaultDrmSessionManager
import androidx.media3.exoplayer.drm.FrameworkMediaDrm
import androidx.media3.exoplayer.drm.LocalMediaDrmCallback
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import com.nemotv.player.data.model.Channel
import com.nemotv.player.data.model.StreamSource
import java.nio.charset.StandardCharsets
import java.util.Base64

import androidx.media3.datasource.HttpDataSource
import com.nemotv.player.data.repository.ChannelRepository
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

@OptIn(UnstableApi::class)
class NemoExoPlayer(
    private val context: Context,
    private val repository: ChannelRepository? = null
) {

    var exoPlayer: ExoPlayer? = null
        private set

    var currentChannel: Channel? = null
        private set
    var currentSourceIndex: Int = 0
        private set

    private val playerScope = CoroutineScope(Dispatchers.Main)
    private var isRefreshingTokens = false

    var onStateChanged: ((isPlaying: Boolean, isBuffering: Boolean, errorMsg: String?) -> Unit)? = null
    var onSourceSwitched: ((sourceIndex: Int, totalSources: Int) -> Unit)? = null

    init {
        initPlayer()
    }

    private fun initPlayer() {
        val renderersFactory = androidx.media3.exoplayer.DefaultRenderersFactory(context).apply {
            setExtensionRendererMode(androidx.media3.exoplayer.DefaultRenderersFactory.EXTENSION_RENDERER_MODE_PREFER)
            setEnableDecoderFallback(true)
        }
        val audioAttributes = androidx.media3.common.AudioAttributes.Builder()
            .setUsage(C.USAGE_MEDIA)
            .setContentType(C.AUDIO_CONTENT_TYPE_MOVIE)
            .build()

        exoPlayer = ExoPlayer.Builder(context, renderersFactory)
            .setAudioAttributes(audioAttributes, true)
            .build().apply {
            playWhenReady = true
            addListener(object : Player.Listener {
                override fun onPlaybackStateChanged(state: Int) {
                    val isBuffering = state == Player.STATE_BUFFERING
                    val isPlaying = isPlaying
                    onStateChanged?.invoke(isPlaying, isBuffering, null)
                }

                override fun onIsPlayingChanged(isPlaying: Boolean) {
                    val isBuffering = exoPlayer?.playbackState == Player.STATE_BUFFERING
                    onStateChanged?.invoke(isPlaying, isBuffering, null)
                }

                override fun onPlayerError(error: PlaybackException) {
                    val cause = error.cause
                    val isAuthFailure = (cause is HttpDataSource.InvalidResponseCodeException &&
                            (cause.responseCode == 401 || cause.responseCode == 403))

                    if (isAuthFailure && repository != null && !isRefreshingTokens) {
                        isRefreshingTokens = true
                        onStateChanged?.invoke(false, true, "Refreshing Live Stream Token...")
                        playerScope.launch {
                            val ok = repository.refreshLiveTokens()
                            isRefreshingTokens = false
                            if (ok) {
                                val ch = currentChannel
                                val updatedCh = repository.allChannels.firstOrNull { it.id == ch?.id }
                                if (updatedCh != null) {
                                    playChannel(updatedCh, 0)
                                    return@launch
                                }
                            }
                            switchNextSource("Token expired / Auth failure")
                        }
                        return
                    }

                    onStateChanged?.invoke(false, false, error.message)
                    // Trigger auto-failover
                    switchNextSource("Playback error")
                }
            })
        }
    }

    fun playChannel(channel: Channel, sourceIdx: Int = 0) {
        currentChannel = channel
        currentSourceIndex = sourceIdx
        val sources = channel.sources
        if (sources.isEmpty()) {
            onStateChanged?.invoke(false, false, "No stream sources available")
            return
        }

        val source = sources.getOrElse(sourceIdx) { sources[0] }

        // Check if token has an expired exp timestamp
        val cookie = source.headers?.get("Cookie") ?: ""
        val expMatch = Regex("exp=(\\d+)").find(cookie + " " + source.url)
        val expTime = expMatch?.groupValues?.get(1)?.toLongOrNull()
        val nowSec = System.currentTimeMillis() / 1000

        if (expTime != null && expTime < nowSec && repository != null && !isRefreshingTokens) {
            isRefreshingTokens = true
            onStateChanged?.invoke(false, true, "Updating Stream Security Token...")
            playerScope.launch {
                repository.refreshLiveTokens()
                isRefreshingTokens = false
                val updatedCh = repository.allChannels.firstOrNull { it.id == channel.id } ?: channel
                currentChannel = updatedCh
                val s = updatedCh.sources.getOrElse(sourceIdx) { updatedCh.sources.firstOrNull() ?: source }
                playSource(s)
                onSourceSwitched?.invoke(sourceIdx, updatedCh.sources.size)
            }
            return
        }

        playSource(source)
        onSourceSwitched?.invoke(sourceIdx, sources.size)
    }

    fun switchNextSource(reason: String = "Manual switch"): Boolean {
        val ch = currentChannel ?: return false
        val sources = ch.sources
        if (sources.size <= 1) return false

        val nextIdx = (currentSourceIndex + 1) % sources.size
        playChannel(ch, nextIdx)
        return true
    }

    private fun playSource(source: StreamSource) {
        val player = exoPlayer ?: return
        val rawUrl = source.url.trim()

        val defaultUserAgent = source.headers?.get("User-Agent")
            ?: "Mozilla/5.0 (SmartTV; NemoTV/2.0) AppleWebKit/537.36 Chrome/120.0"

        val httpDataSourceFactory = DefaultHttpDataSource.Factory()
            .setUserAgent(defaultUserAgent)
            .setAllowCrossProtocolRedirects(true)
            .setConnectTimeoutMs(15000)
            .setReadTimeoutMs(20000)

        source.headers?.let { headers ->
            val custom = headers.filterKeys { !it.equals("User-Agent", ignoreCase = true) }
            if (custom.isNotEmpty()) {
                httpDataSourceFactory.setDefaultRequestProperties(custom)
            }
        }

        val mediaSourceFactory = DefaultMediaSourceFactory(context)
            .setDataSourceFactory(httpDataSourceFactory)

        val mediaItemBuilder = MediaItem.Builder().setUri(Uri.parse(rawUrl))

        if (rawUrl.contains(".mpd", ignoreCase = true) || source.manifestType == "mpd") {
            mediaItemBuilder.setMimeType(MimeTypes.APPLICATION_MPD)
        } else if (rawUrl.contains(".m3u8", ignoreCase = true) || source.manifestType == "hls") {
            mediaItemBuilder.setMimeType(MimeTypes.APPLICATION_M3U8)
        }

        // Configure ClearKey DRM if present
        val drmKey = source.drm?.key
        if (!drmKey.isNullOrBlank() && (source.drm?.type?.contains("clearkey", ignoreCase = true) == true || drmKey.contains(":"))) {
            val jsonBytes = buildClearKeyW3cJsonBytes(drmKey)
            if (jsonBytes != null) {
                val callback = LocalMediaDrmCallback(jsonBytes)
                val drmManager = DefaultDrmSessionManager.Builder()
                    .setUuidAndExoMediaDrmProvider(C.CLEARKEY_UUID, FrameworkMediaDrm.DEFAULT_PROVIDER)
                    .setMultiSession(true)
                    .setPlayClearSamplesWithoutKeys(true)
                    .build(callback)
                mediaSourceFactory.setDrmSessionManagerProvider { drmManager }

                val drmConfig = MediaItem.DrmConfiguration.Builder(C.CLEARKEY_UUID)
                    .setMultiSession(true)
                    .build()
                mediaItemBuilder.setDrmConfiguration(drmConfig)
            }
        }

        val mediaSource = mediaSourceFactory.createMediaSource(mediaItemBuilder.build())
        player.setMediaSource(mediaSource)
        player.prepare()
        player.play()
    }

    private fun buildClearKeyW3cJsonBytes(rawKey: String): ByteArray? {
        return try {
            val pairs = rawKey.split(",", "\n", " ")
                .map { it.trim() }
                .filter { it.contains(":") }

            if (pairs.isEmpty()) return null

            val encoder = Base64.getUrlEncoder().withoutPadding()
            val entries = mutableListOf<String>()

            for (pair in pairs) {
                val parts = pair.split(":")
                if (parts.size >= 2) {
                    val kidHex = parts[0].trim().replace("-", "").replace(" ", "")
                    val keyHex = parts[1].trim().replace("-", "").replace(" ", "")

                    if (kidHex.length % 2 == 0 && keyHex.length % 2 == 0 && kidHex.isNotEmpty() && keyHex.isNotEmpty()) {
                        val kidBytes = hexToBytes(kidHex)
                        val keyBytes = hexToBytes(keyHex)
                        val kidB64 = encoder.encodeToString(kidBytes)
                        val keyB64 = encoder.encodeToString(keyBytes)
                        entries.add("""{"kty":"oct","k":"$keyB64","kid":"$kidB64"}""")
                    }
                }
            }

            if (entries.isEmpty()) return null
            val json = """{"keys":[${entries.joinToString(",")}], "type":"temporary"}"""
            json.toByteArray(StandardCharsets.UTF_8)
        } catch (_: Exception) {
            null
        }
    }

    private fun hexToBytes(hex: String): ByteArray {
        val len = hex.length
        val data = ByteArray(len / 2)
        var i = 0
        while (i < len) {
            val high = Character.digit(hex[i], 16)
            val low = Character.digit(hex[i + 1], 16)
            data[i / 2] = ((high shl 4) + low).toByte()
            i += 2
        }
        return data
    }

    fun release() {
        playerScope.cancel()
        exoPlayer?.release()
        exoPlayer = null
    }
}
