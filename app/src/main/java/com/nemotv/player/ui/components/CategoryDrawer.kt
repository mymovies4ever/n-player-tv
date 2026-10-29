package com.nemotv.player.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.nemotv.player.ui.theme.CardBorder
import com.nemotv.player.ui.theme.FocusCyan
import com.nemotv.player.ui.theme.SurfaceDark
import com.nemotv.player.ui.theme.TextPrimary
import com.nemotv.player.ui.theme.TextSecondary

@Composable
fun FilterChipRow(
    items: List<String>,
    selectedItem: String,
    prefix: String = "",
    onSelect: (String) -> Unit
) {
    LazyRow(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        contentPadding = PaddingValues(horizontal = 24.dp)
    ) {
        items(items) { item ->
            val isSelected = item == selectedItem
            var isFocused by remember { mutableStateOf(false) }

            val bgColor = when {
                isSelected -> FocusCyan.copy(alpha = 0.25f)
                isFocused -> Color(0xFF1E293B)
                else -> SurfaceDark.copy(alpha = 0.8f)
            }

            val borderColor = when {
                isFocused -> FocusCyan
                isSelected -> FocusCyan.copy(alpha = 0.6f)
                else -> CardBorder
            }

            val textColor = when {
                isSelected || isFocused -> FocusCyan
                else -> TextSecondary
            }

            Box(
                modifier = Modifier
                    .clip(RoundedCornerShape(8.dp))
                    .background(bgColor)
                    .border(if (isFocused) 2.dp else 1.dp, borderColor, RoundedCornerShape(8.dp))
                    .onFocusChanged { isFocused = it.isFocused }
                    .focusable()
                    .clickable { onSelect(item) }
                    .padding(horizontal = 14.dp, vertical = 7.dp),
                contentAlignment = Alignment.Center
            ) {
                Text(
                    text = if (prefix.isNotBlank() && item != items.firstOrNull()) "$prefix $item" else item,
                    color = textColor,
                    fontSize = 13.sp,
                    fontWeight = if (isSelected || isFocused) FontWeight.Bold else FontWeight.Medium
                )
            }
        }
    }
}
