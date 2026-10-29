package com.nemotv.player.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.nemotv.player.ui.theme.AccentOrange
import com.nemotv.player.ui.theme.FocusCyan
import com.nemotv.player.ui.theme.GoldHighlight

@Composable
fun ChannelNumberOSD(
    numberString: String,
    channelName: String?
) {
    if (numberString.isBlank()) return

    Box(
        modifier = Modifier
            .fillMaxSize()
            .padding(top = 36.dp, end = 36.dp),
        contentAlignment = Alignment.TopEnd
    ) {
        Box(
            modifier = Modifier
                .background(
                    Brush.verticalGradient(
                        listOf(Color(0xE60D172E), Color(0xF2060B17))
                    ),
                    RoundedCornerShape(14.dp)
                )
                .border(2.dp, FocusCyan, RoundedCornerShape(14.dp))
                .padding(horizontal = 22.dp, vertical = 14.dp),
            contentAlignment = Alignment.Center
        ) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Text(
                    text = numberString,
                    color = FocusCyan,
                    fontSize = 38.sp,
                    fontWeight = FontWeight.Black,
                    letterSpacing = 3.sp
                )

                Spacer(modifier = Modifier.height(4.dp))

                Text(
                    text = channelName ?: "⚠️ Channel not found",
                    color = if (channelName != null) GoldHighlight else AccentOrange,
                    fontSize = 15.sp,
                    fontWeight = FontWeight.Bold
                )
            }
        }
    }
}
