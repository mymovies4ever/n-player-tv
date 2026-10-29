package com.nemotv.player.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Tv
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.nemotv.player.data.model.Channel
import com.nemotv.player.data.repository.ChannelRepository
import com.nemotv.player.ui.components.ChannelCard
import com.nemotv.player.ui.components.FilterChipRow
import com.nemotv.player.ui.theme.BgDark
import com.nemotv.player.ui.theme.FocusCyan
import com.nemotv.player.ui.theme.TextPrimary
import com.nemotv.player.ui.theme.TextSecondary

@Composable
fun TVGuideScreen(
    repository: ChannelRepository,
    onChannelSelected: (Channel) -> Unit
) {
    var selectedCategory by remember { mutableStateOf("All Channels") }
    var selectedLanguage by remember { mutableStateOf("All Languages") }

    val displayedChannels = remember(selectedCategory, selectedLanguage, repository.allChannels) {
        repository.getFilteredChannels(
            category = selectedCategory,
            language = selectedLanguage
        )
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(BgDark)
    ) {
        // App Top Header Bar
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 24.dp, vertical = 14.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(
                    imageVector = Icons.Default.Tv,
                    contentDescription = null,
                    tint = FocusCyan,
                    modifier = Modifier.size(28.dp)
                )
                Spacer(modifier = Modifier.width(10.dp))
                Column {
                    Text(
                        text = "Nemo TV",
                        color = Color.White,
                        fontSize = 20.sp,
                        fontWeight = FontWeight.Black
                    )
                    Text(
                        text = "Smart Live TV Fleet",
                        color = TextSecondary,
                        fontSize = 11.sp
                    )
                }
            }

            // Stats Pill
            Box(
                modifier = Modifier
                    .background(Color.White.copy(alpha = 0.06f), androidx.compose.foundation.shape.RoundedCornerShape(16.dp))
                    .padding(horizontal = 14.dp, vertical = 6.dp)
            ) {
                Text(
                    text = "${displayedChannels.size} Channels Active",
                    color = FocusCyan,
                    fontSize = 12.sp,
                    fontWeight = FontWeight.Bold
                )
            }
        }

        // Category Filter Row
        FilterChipRow(
            items = repository.categories,
            selectedItem = selectedCategory,
            onSelect = { selectedCategory = it }
        )

        // Language Filter Row
        FilterChipRow(
            items = repository.languages,
            selectedItem = selectedLanguage,
            prefix = "🌐",
            onSelect = { selectedLanguage = it }
        )

        Spacer(modifier = Modifier.height(8.dp))

        // 6-Column Channel Grid
        LazyVerticalGrid(
            columns = GridCells.Fixed(6),
            modifier = Modifier
                .fillMaxSize()
                .padding(horizontal = 20.dp),
            contentPadding = PaddingValues(bottom = 24.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            items(displayedChannels, key = { it.id }) { channel ->
                ChannelCard(
                    channel = channel,
                    modifier = Modifier.height(130.dp),
                    onSelect = onChannelSelected
                )
            }
        }
    }
}
