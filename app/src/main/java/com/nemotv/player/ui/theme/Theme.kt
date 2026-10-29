package com.nemotv.player.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable

private val DarkColorScheme = darkColorScheme(
    primary = FocusCyan,
    secondary = AccentOrange,
    background = BgDark,
    surface = SurfaceDark,
    onPrimary = BgDark,
    onBackground = TextPrimary,
    onSurface = TextPrimary
)

@Composable
fun NemoTVTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = DarkColorScheme,
        content = content
    )
}
