package com.nemotv.player.ui.screens

import android.view.ViewGroup
import android.widget.FrameLayout
import androidx.annotation.OptIn
import androidx.compose.animation.*
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.media3.common.util.UnstableApi
import androidx.media3.ui.PlayerView
import coil.compose.AsyncImage
import coil.request.ImageRequest
import com.nemotv.player.data.model.Channel
import com.nemotv.player.data.repository.ChannelRepository
import com.nemotv.player.player.NemoExoPlayer
import com.nemotv.player.ui.theme.*
import kotlinx.coroutines.delay

@OptIn(UnstableApi::class)
@Composable
fun TVPlayerScreen(
    channel: Channel,
    repository: ChannelRepository,
    nemoPlayer: NemoExoPlayer,
    isMiniEpgOpen: Boolean,
    onToggleMiniEpg: () -> Unit,
    onCloseMiniEpg: () -> Unit,
    onChannelChange: (Channel) -> Unit,
    onBackToGuide: () -> Unit
) {
    val context = LocalContext.current
    var isBuffering by remember { mutableStateOf(true) }
    var bufferingMessage by remember { mutableStateOf<String?>("Tuning to Broadcast Stream...") }
    var errorMessage by remember { mutableStateOf<String?>(null) }
    var showStbBanner by remember { mutableStateOf(true) }
    var activeSourceIndex by remember { mutableIntStateOf(0) }
    var focusedChannelForPreview by remember { mutableStateOf(channel) }

    // Start playing the channel
    LaunchedEffect(channel) {
        focusedChannelForPreview = channel
        showStbBanner = true
        bufferingMessage = "Tuning to Broadcast Stream..."
        nemoPlayer.playChannel(channel, 0)
    }

    // Auto-hide STB Banner after 4.5 seconds
    LaunchedEffect(showStbBanner, channel) {
        if (showStbBanner) {
            delay(4500)
            showStbBanner = false
        }
    }

    // Listen to player state
    DisposableEffect(nemoPlayer) {
        nemoPlayer.onStateChanged = { _, buffering, msg ->
            isBuffering = buffering
            if (buffering) {
                bufferingMessage = msg ?: "Tuning to Broadcast Stream..."
                errorMessage = null
            } else {
                errorMessage = msg
            }
        }
        nemoPlayer.onSourceSwitched = { sIdx, _ ->
            activeSourceIndex = sIdx
        }
        onDispose {
            nemoPlayer.onStateChanged = null
            nemoPlayer.onSourceSwitched = null
        }
    }

    val epgInfo = remember(channel) { repository.getEpgProgram(channel) }
    val spotlightEpg = remember(focusedChannelForPreview) { repository.getEpgProgram(focusedChannelForPreview) }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color.Black)
    ) {
        // Native Media3 PlayerView with tap-to-toggle controls
        Box(
            modifier = Modifier
                .fillMaxSize()
                .clickable {
                    if (isMiniEpgOpen) {
                        onCloseMiniEpg()
                    } else {
                        showStbBanner = !showStbBanner
                    }
                }
        ) {
            AndroidView(
                modifier = Modifier.fillMaxSize(),
                factory = { ctx ->
                    PlayerView(ctx).apply {
                        layoutParams = FrameLayout.LayoutParams(
                            ViewGroup.LayoutParams.MATCH_PARENT,
                            ViewGroup.LayoutParams.MATCH_PARENT
                        )
                        useController = false
                        player = nemoPlayer.exoPlayer
                    }
                },
                update = { view ->
                    view.player = nemoPlayer.exoPlayer
                }
            )
        }

        // Playback Error Overlay
        if (errorMessage != null && !isBuffering) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .background(Color.Black.copy(alpha = 0.65f)),
                contentAlignment = Alignment.Center
            ) {
                Column(
                    horizontalAlignment = Alignment.CenterHorizontally,
                    modifier = Modifier
                        .background(Color(0xFF0F172A), RoundedCornerShape(16.dp))
                        .border(1.5.dp, AccentOrange, RoundedCornerShape(16.dp))
                        .padding(24.dp)
                ) {
                    Text("⚠️ Playback Notice", color = AccentOrange, fontSize = 20.sp, fontWeight = FontWeight.Bold)
                    Spacer(modifier = Modifier.height(8.dp))
                    Text(
                        text = errorMessage ?: "Unable to play stream",
                        color = Color.White,
                        fontSize = 14.sp
                    )
                    Spacer(modifier = Modifier.height(16.dp))
                    Row {
                        Button(
                            onClick = { nemoPlayer.switchNextSource("User retry") },
                            colors = ButtonDefaults.buttonColors(containerColor = FocusCyan),
                            shape = RoundedCornerShape(10.dp)
                        ) {
                            Text("Switch Source / Retry", color = Color.Black, fontWeight = FontWeight.Bold)
                        }
                        Spacer(modifier = Modifier.width(12.dp))
                        OutlinedButton(
                            onClick = onBackToGuide,
                            shape = RoundedCornerShape(10.dp)
                        ) {
                            Text("Back to Guide", color = Color.White)
                        }
                    }
                }
            }
        }

        // Loading Spinner during initial connect / buffer
        if (isBuffering && errorMessage == null) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .background(Color.Black.copy(alpha = 0.45f)),
                contentAlignment = Alignment.Center
            ) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    CircularProgressIndicator(
                        color = FocusCyan,
                        strokeWidth = 4.dp,
                        modifier = Modifier.size(46.dp)
                    )
                    Spacer(modifier = Modifier.height(14.dp))
                    Text(
                        text = bufferingMessage ?: "Tuning to Broadcast Stream...",
                        color = FocusCyan,
                        fontSize = 15.sp,
                        fontWeight = FontWeight.Bold
                    )
                }
            }
        }

        // Top STB Broadcast Banner (Auto-Hides)
        AnimatedVisibility(
            visible = showStbBanner && !isMiniEpgOpen,
            enter = slideInVertically(initialOffsetY = { -it }) + fadeIn(),
            exit = slideOutVertically(targetOffsetY = { -it }) + fadeOut(),
            modifier = Modifier.align(Alignment.TopCenter)
        ) {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(
                        Brush.verticalGradient(
                            listOf(Color(0xF0060B17), Color(0xCC0D172E), Color.Transparent)
                        )
                    )
                    .padding(horizontal = 36.dp, vertical = 20.dp)
            ) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        IconButton(onClick = onBackToGuide) {
                            Icon(Icons.Default.ArrowBack, contentDescription = "Back", tint = Color.White)
                        }

                        Spacer(modifier = Modifier.width(8.dp))

                        // Logo
                        AsyncImage(
                            model = ImageRequest.Builder(context).data(channel.logo).crossfade(true).build(),
                            contentDescription = channel.name,
                            contentScale = ContentScale.Fit,
                            modifier = Modifier
                                .size(56.dp)
                                .clip(RoundedCornerShape(8.dp))
                                .background(Color.White.copy(alpha = 0.08f))
                                .padding(4.dp)
                        )

                        Spacer(modifier = Modifier.width(16.dp))

                        Column {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                // Channel Number Badge
                                Box(
                                    modifier = Modifier
                                        .background(FocusCyan.copy(alpha = 0.22f), RoundedCornerShape(6.dp))
                                        .padding(horizontal = 8.dp, vertical = 3.dp)
                                ) {
                                    Text(
                                        text = "#${channel.channelNumber.toString().padStart(3, '0')}",
                                        color = FocusCyan,
                                        fontSize = 15.sp,
                                        fontWeight = FontWeight.Bold
                                    )
                                }
                                Spacer(modifier = Modifier.width(10.dp))
                                Text(
                                    text = channel.name,
                                    color = Color.White,
                                    fontSize = 24.sp,
                                    fontWeight = FontWeight.Black
                                )
                            }

                            Spacer(modifier = Modifier.height(4.dp))

                            Text(
                                text = "🔴 NOW: ${epgInfo.currentTitle} • ${epgInfo.timeSlot}",
                                color = GoldHighlight,
                                fontSize = 15.sp,
                                fontWeight = FontWeight.Bold
                            )
                        }
                    }

                    // Source & Quality Badges
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Box(
                            modifier = Modifier
                                .background(Color.White.copy(alpha = 0.1f), RoundedCornerShape(6.dp))
                                .padding(horizontal = 10.dp, vertical = 4.dp)
                        ) {
                            Text(
                                text = "Source ${activeSourceIndex + 1} of ${channel.sources.size}",
                                color = AccentOrange,
                                fontSize = 12.sp,
                                fontWeight = FontWeight.Bold
                            )
                        }
                        Spacer(modifier = Modifier.width(8.dp))
                        Box(
                            modifier = Modifier
                                .background(FocusCyan.copy(alpha = 0.2f), RoundedCornerShape(6.dp))
                                .padding(horizontal = 8.dp, vertical = 4.dp)
                        ) {
                            Text("1080p FHD", color = FocusCyan, fontSize = 12.sp, fontWeight = FontWeight.Bold)
                        }
                    }
                }
            }
        }

        // Floating On-Screen "Channels (OK)" button for mobile touch and mouse navigation
        AnimatedVisibility(
            visible = showStbBanner && !isMiniEpgOpen,
            enter = fadeIn() + slideInVertically(initialOffsetY = { it }),
            exit = fadeOut() + slideOutVertically(targetOffsetY = { it }),
            modifier = Modifier
                .align(Alignment.BottomEnd)
                .padding(end = 28.dp, bottom = 28.dp)
        ) {
            Button(
                onClick = onToggleMiniEpg,
                shape = RoundedCornerShape(14.dp),
                colors = ButtonDefaults.buttonColors(containerColor = FocusCyan),
                elevation = ButtonDefaults.buttonElevation(defaultElevation = 8.dp)
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("📺", fontSize = 16.sp)
                    Spacer(modifier = Modifier.width(8.dp))
                    Text(
                        "Channels (OK)",
                        color = Color.Black,
                        fontWeight = FontWeight.Bold,
                        fontSize = 15.sp
                    )
                }
            }
        }

        // Mini-EPG Quick Channel Drawer (Triggered by OK / Remote Enter / Touch)
        AnimatedVisibility(
            visible = isMiniEpgOpen,
            enter = slideInVertically(initialOffsetY = { it }) + fadeIn(),
            exit = slideOutVertically(targetOffsetY = { it }) + fadeOut(),
            modifier = Modifier.align(Alignment.BottomCenter)
        ) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(
                        Brush.verticalGradient(
                            listOf(Color.Transparent, Color(0xF2060B17), Color(0xFA040710))
                        )
                    )
                    .padding(bottom = 20.dp)
            ) {
                // Top Spotlight Preview for Focused Channel in Drawer
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 28.dp, vertical = 12.dp)
                        .background(Color(0xFF0D172E).copy(alpha = 0.9f), RoundedCornerShape(12.dp))
                        .border(1.5.dp, FocusCyan.copy(alpha = 0.7f), RoundedCornerShape(12.dp))
                        .padding(horizontal = 20.dp, vertical = 10.dp)
                ) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Column {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text(
                                    text = "#${focusedChannelForPreview.channelNumber.toString().padStart(3, '0')}",
                                    color = FocusCyan,
                                    fontSize = 18.sp,
                                    fontWeight = FontWeight.Bold
                                )
                                Spacer(modifier = Modifier.width(10.dp))
                                Text(
                                    text = focusedChannelForPreview.name,
                                    color = Color.White,
                                    fontSize = 20.sp,
                                    fontWeight = FontWeight.Black
                                )
                                Spacer(modifier = Modifier.width(10.dp))
                                Text(
                                    text = "• ${focusedChannelForPreview.category ?: "General"}",
                                    color = TextSecondary,
                                    fontSize = 14.sp
                                )
                            }
                            Spacer(modifier = Modifier.height(3.dp))
                            Text(
                                text = "🔴 NOW: ${spotlightEpg.currentTitle} (${spotlightEpg.timeSlot})",
                                color = GoldHighlight,
                                fontSize = 15.sp,
                                fontWeight = FontWeight.Bold
                            )
                        }

                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(
                                text = "NEXT: ${spotlightEpg.nextTitle}",
                                color = TextSecondary,
                                fontSize = 13.sp,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis
                            )
                            Spacer(modifier = Modifier.width(14.dp))
                            IconButton(
                                onClick = onCloseMiniEpg,
                                modifier = Modifier
                                    .size(32.dp)
                                    .background(Color.White.copy(alpha = 0.12f), CircleShape)
                            ) {
                                Text("✕", color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.Bold)
                            }
                        }
                    }
                }

                // Horizontal Mini Channel Cards Carousel
                LazyRow(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                    contentPadding = PaddingValues(horizontal = 28.dp)
                ) {
                    items(repository.allChannels, key = { it.id }) { ch ->
                        var isCardFocused by remember { mutableStateOf(false) }
                        val isCurrent = ch.id == channel.id
                        val epg = remember(ch) { repository.getEpgProgram(ch) }

                        Box(
                            modifier = Modifier
                                .width(250.dp)
                                .height(115.dp)
                                .clip(RoundedCornerShape(10.dp))
                                .background(if (isCardFocused) Color(0xFF132247) else SurfaceDark.copy(alpha = 0.95f))
                                .border(
                                    if (isCardFocused) 2.5.dp else if (isCurrent) 1.5.dp else 1.dp,
                                    if (isCardFocused) FocusCyan else if (isCurrent) AccentOrange else CardBorder,
                                    RoundedCornerShape(10.dp)
                                )
                                .onFocusChanged {
                                    isCardFocused = it.isFocused
                                    if (it.isFocused) {
                                        focusedChannelForPreview = ch
                                    }
                                }
                                .focusable()
                                .clickable {
                                    onChannelChange(ch)
                                    onCloseMiniEpg()
                                }
                                .padding(10.dp)
                        ) {
                            Column(
                                modifier = Modifier.fillMaxSize(),
                                verticalArrangement = Arrangement.SpaceBetween
                            ) {
                                Row(
                                    modifier = Modifier.fillMaxWidth(),
                                    horizontalArrangement = Arrangement.SpaceBetween,
                                    verticalAlignment = Alignment.CenterVertically
                                ) {
                                    Text(
                                        text = "#${ch.channelNumber.toString().padStart(3, '0')}",
                                        color = FocusCyan,
                                        fontSize = 12.sp,
                                        fontWeight = FontWeight.Bold
                                    )
                                    AsyncImage(
                                        model = ch.logo,
                                        contentDescription = ch.name,
                                        modifier = Modifier.size(24.dp)
                                    )
                                }

                                Text(
                                    text = ch.name,
                                    color = Color.White,
                                    fontSize = 14.sp,
                                    fontWeight = FontWeight.Bold,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis
                                )

                                Text(
                                    text = "📺 ${epg.currentTitle}",
                                    color = if (isCardFocused) GoldHighlight else TextSecondary,
                                    fontSize = 12.sp,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}
