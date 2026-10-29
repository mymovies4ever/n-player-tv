package com.nemotv.player.ui

import android.os.Bundle
import android.view.KeyEvent
import android.view.WindowManager
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.annotation.OptIn
import androidx.compose.animation.*
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.lifecycle.lifecycleScope
import androidx.media3.common.util.UnstableApi
import com.nemotv.player.data.model.Channel
import com.nemotv.player.data.repository.ChannelRepository
import com.nemotv.player.player.NemoExoPlayer
import com.nemotv.player.ui.components.ChannelNumberOSD
import com.nemotv.player.ui.components.SplashView
import com.nemotv.player.ui.screens.TVGuideScreen
import com.nemotv.player.ui.screens.TVPlayerScreen
import com.nemotv.player.ui.theme.NemoTVTheme
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@OptIn(UnstableApi::class)
class MainActivity : ComponentActivity() {

    private lateinit var repository: ChannelRepository
    private lateinit var nemoPlayer: NemoExoPlayer

    private var activeChannelState = mutableStateOf<Channel?>(null)
    private var isPlayingVideo = mutableStateOf(false)
    private var isMiniEpgOpen = mutableStateOf(false)
    private var numberInput = mutableStateOf("")
    private var matchedChannelName = mutableStateOf<String?>(null)
    private var numberCommitJob: Job? = null

    private var lastBackPressTime = 0L

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        hideSystemUI()

        repository = ChannelRepository(applicationContext)
        nemoPlayer = NemoExoPlayer(applicationContext)

        setContent {
            NemoTVTheme {
                var isSplashActive by remember { mutableStateOf(true) }
                var splashText by remember { mutableStateOf("Initializing Master Fleet...") }

                val playingChannel = activeChannelState.value
                val isPlaying = isPlayingVideo.value
                val miniEpgOpen = isMiniEpgOpen.value
                val currentNumber = numberInput.value
                val currentMatch = matchedChannelName.value

                LaunchedEffect(Unit) {
                    val channels = repository.initialize()
                    splashText = "Loaded ${channels.size} Channels • Fleet Ready"
                    delay(1200)
                    isSplashActive = false
                }

                Box(modifier = Modifier.fillMaxSize()) {
                    if (isSplashActive) {
                        SplashView(statusText = splashText)
                    } else if (isPlaying && playingChannel != null) {
                        TVPlayerScreen(
                            channel = playingChannel,
                            repository = repository,
                            nemoPlayer = nemoPlayer,
                            isMiniEpgOpen = miniEpgOpen,
                            onToggleMiniEpg = { isMiniEpgOpen.value = !isMiniEpgOpen.value },
                            onCloseMiniEpg = { isMiniEpgOpen.value = false },
                            onChannelChange = { newCh ->
                                activeChannelState.value = newCh
                            },
                            onBackToGuide = {
                                isPlayingVideo.value = false
                                nemoPlayer.exoPlayer?.pause()
                            }
                        )
                    } else {
                        TVGuideScreen(
                            repository = repository,
                            onChannelSelected = { ch ->
                                activeChannelState.value = ch
                                isPlayingVideo.value = true
                                isMiniEpgOpen.value = false
                            }
                        )
                    }

                    // Direct Numeric Dialing OSD
                    if (currentNumber.isNotBlank()) {
                        ChannelNumberOSD(
                            numberString = currentNumber,
                            channelName = currentMatch
                        )
                    }
                }
            }
        }
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        // Handle Direct Number Dialing (0-9 and Numpad 0-9)
        val digit = when (keyCode) {
            KeyEvent.KEYCODE_0, KeyEvent.KEYCODE_NUMPAD_0 -> "0"
            KeyEvent.KEYCODE_1, KeyEvent.KEYCODE_NUMPAD_1 -> "1"
            KeyEvent.KEYCODE_2, KeyEvent.KEYCODE_NUMPAD_2 -> "2"
            KeyEvent.KEYCODE_3, KeyEvent.KEYCODE_NUMPAD_3 -> "3"
            KeyEvent.KEYCODE_4, KeyEvent.KEYCODE_NUMPAD_4 -> "4"
            KeyEvent.KEYCODE_5, KeyEvent.KEYCODE_NUMPAD_5 -> "5"
            KeyEvent.KEYCODE_6, KeyEvent.KEYCODE_NUMPAD_6 -> "6"
            KeyEvent.KEYCODE_7, KeyEvent.KEYCODE_NUMPAD_7 -> "7"
            KeyEvent.KEYCODE_8, KeyEvent.KEYCODE_NUMPAD_8 -> "8"
            KeyEvent.KEYCODE_9, KeyEvent.KEYCODE_NUMPAD_9 -> "9"
            else -> null
        }

        if (digit != null) {
            numberCommitJob?.cancel()
            val newStr = (numberInput.value + digit).take(4)
            numberInput.value = newStr

            val num = newStr.toIntOrNull()
            val match = repository.allChannels.firstOrNull { it.channelNumber == num }
            matchedChannelName.value = match?.name

            numberCommitJob = lifecycleScope.launch {
                delay(1400)
                commitNumberTuning()
            }
            return true
        }

        when (keyCode) {
            KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER -> {
                if (numberInput.value.isNotBlank()) {
                    numberCommitJob?.cancel()
                    commitNumberTuning()
                    return true
                }
                if (isPlayingVideo.value) {
                    isMiniEpgOpen.value = !isMiniEpgOpen.value
                    return true
                }
            }
            KeyEvent.KEYCODE_BACK, KeyEvent.KEYCODE_ESCAPE -> {
                if (numberInput.value.isNotBlank()) {
                    numberCommitJob?.cancel()
                    numberInput.value = ""
                    matchedChannelName.value = null
                    return true
                }
                if (isPlayingVideo.value) {
                    if (isMiniEpgOpen.value) {
                        isMiniEpgOpen.value = false
                        return true
                    }
                    isPlayingVideo.value = false
                    nemoPlayer.exoPlayer?.pause()
                    return true
                }
                val now = System.currentTimeMillis()
                if (now - lastBackPressTime < 2500) {
                    finish()
                } else {
                    lastBackPressTime = now
                    Toast.makeText(this, "Press Back again to exit", Toast.LENGTH_SHORT).show()
                }
                return true
            }
            KeyEvent.KEYCODE_CHANNEL_UP, KeyEvent.KEYCODE_PAGE_UP -> {
                tuneAdjacentChannel(1)
                return true
            }
            KeyEvent.KEYCODE_CHANNEL_DOWN, KeyEvent.KEYCODE_PAGE_DOWN -> {
                tuneAdjacentChannel(-1)
                return true
            }
            KeyEvent.KEYCODE_PROG_YELLOW -> {
                nemoPlayer.switchNextSource("Manual switch")
                return true
            }
        }

        return super.onKeyDown(keyCode, event)
    }

    private fun commitNumberTuning() {
        val num = numberInput.value.toIntOrNull()
        numberInput.value = ""
        matchedChannelName.value = null

        if (num != null) {
            val target = repository.allChannels.firstOrNull { it.channelNumber == num }
            if (target != null) {
                activeChannelState.value = target
                isPlayingVideo.value = true
                isMiniEpgOpen.value = false
            } else {
                Toast.makeText(this, "Channel #$num not found", Toast.LENGTH_SHORT).show()
            }
        }
    }

    private fun tuneAdjacentChannel(delta: Int) {
        val current = activeChannelState.value ?: return
        val list = repository.allChannels
        if (list.isEmpty()) return

        val currentIdx = list.indexOfFirst { it.id == current.id }
        if (currentIdx >= 0) {
            val nextIdx = (currentIdx + delta + list.size) % list.size
            activeChannelState.value = list[nextIdx]
            isPlayingVideo.value = true
        }
    }

    private fun hideSystemUI() {
        try {
            WindowCompat.setDecorFitsSystemWindows(window, false)
            val controller = WindowCompat.getInsetsController(window, window.decorView)
            controller.hide(WindowInsetsCompat.Type.systemBars())
            controller.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        } catch (_: Exception) {}
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) hideSystemUI()
    }

    override fun onDestroy() {
        super.onDestroy()
        nemoPlayer.release()
    }
}
