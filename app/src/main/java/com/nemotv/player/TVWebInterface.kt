package com.nemotv.player

import android.app.Activity
import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface
import android.widget.Toast
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

class TVWebInterface(private val activity: Activity) {

    private val executor = Executors.newCachedThreadPool()

    @JavascriptInterface
    fun showToast(message: String) {
        Handler(Looper.getMainLooper()).post {
            Toast.makeText(activity, message, Toast.LENGTH_SHORT).show()
        }
    }

    @JavascriptInterface
    fun exitApp() {
        Handler(Looper.getMainLooper()).post {
            activity.finish()
        }
    }

    @JavascriptInterface
    fun fetchUrl(urlString: String): String {
        return try {
            val future = executor.submit<String> {
                val url = URL(urlString)
                val conn = url.openConnection() as HttpURLConnection
                conn.connectTimeout = 15000
                conn.readTimeout = 20000
                conn.requestMethod = "GET"
                conn.setRequestProperty("User-Agent", "Mozilla/5.0 (SmartTV; webOS; NemoTV/1.0)")
                conn.setRequestProperty("Accept", "*/*")
                if (conn.responseCode in 200..299) {
                    val reader = BufferedReader(InputStreamReader(conn.inputStream))
                    val sb = StringBuilder()
                    var line: String?
                    while (reader.readLine().also { line = it } != null) {
                        sb.append(line).append("\n")
                    }
                    reader.close()
                    sb.toString()
                } else {
                    ""
                }
            }
            future.get()
        } catch (_: Exception) {
            ""
        }
    }

    @JavascriptInterface
    fun loadBundledChannels(): String {
        return try {
            activity.assets.open("default_channels.json").bufferedReader().use { it.readText() }
        } catch (_: Exception) {
            ""
        }
    }
}

