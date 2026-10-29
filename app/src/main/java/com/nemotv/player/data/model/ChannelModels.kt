package com.nemotv.player.data.model

import kotlinx.serialization.Serializable

@Serializable
data class DrmConfig(
    val type: String? = null,
    val key: String? = null
)

@Serializable
data class StreamSource(
    val url: String,
    val manifestType: String? = null,
    val drm: DrmConfig? = null,
    val headers: Map<String, String>? = null,
    val playlistName: String? = null
)

@Serializable
data class Channel(
    val id: String,
    val name: String,
    val title: String? = null,
    val tvgId: String? = null,
    val logo: String? = null,
    val group: String? = null,
    val category: String? = null,
    val language: String? = null,
    val isMovie: Boolean = false,
    val year: String? = null,
    val rating: String? = null,
    val sources: List<StreamSource> = emptyList(),
    var channelNumber: Int = 1
)

data class EpgProgram(
    val currentTitle: String,
    val timeSlot: String,
    val progressPercent: Float = 0.45f,
    val nextTitle: String
)
