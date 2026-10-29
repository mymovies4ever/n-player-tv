package com.nemotv.player

import android.annotation.SuppressLint
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.view.KeyEvent
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.appcompat.app.AppCompatActivity

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Keep screen on during TV broadcast playback
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        hideSystemUI()

        webView = WebView(this).apply {
            setBackgroundColor(Color.parseColor("#060B17"))
            isFocusable = true
            isFocusableInTouchMode = true
        }

        setContentView(webView)

        configureWebView()

        // Attach native bridge
        webView.addJavascriptInterface(TVWebInterface(this), "AndroidNative")

        // Load bundled Nemo TV local application
        webView.loadUrl("file:///android_asset/index.html")
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configureWebView() {
        val settings = webView.settings
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.databaseEnabled = true
        settings.allowFileAccess = true
        settings.allowContentAccess = true
        settings.mediaPlaybackRequiresUserGesture = false
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
        settings.useWideViewPort = true
        settings.loadWithOverviewMode = true
        settings.cacheMode = WebSettings.LOAD_DEFAULT

        // Custom TV User Agent
        settings.userAgentString = "Mozilla/5.0 (Linux; Android 14; Android TV Build/UDC) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 NemoTV/1.0"

        webView.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest?) {
                request?.grant(request.resources)
            }
        }

        webView.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                hideSystemUI()
            }
        }
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        val webKeyCode = mapAndroidKeyToWeb(keyCode)
        if (webKeyCode != null) {
            val script = "(() => { window.dispatchEvent(new KeyboardEvent('keydown', { keyCode: $webKeyCode, which: $webKeyCode, bubbles: true })); })()"
            webView.evaluateJavascript(script, null)
            return true
        }
        return super.onKeyDown(keyCode, event)
    }

    private fun mapAndroidKeyToWeb(keyCode: Int): Int? {
        return when (keyCode) {
            KeyEvent.KEYCODE_DPAD_UP -> 38
            KeyEvent.KEYCODE_DPAD_DOWN -> 40
            KeyEvent.KEYCODE_DPAD_LEFT -> 37
            KeyEvent.KEYCODE_DPAD_RIGHT -> 39
            KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER -> 13
            KeyEvent.KEYCODE_BACK, KeyEvent.KEYCODE_ESCAPE -> 461
            KeyEvent.KEYCODE_0, KeyEvent.KEYCODE_NUMPAD_0 -> 48
            KeyEvent.KEYCODE_1, KeyEvent.KEYCODE_NUMPAD_1 -> 49
            KeyEvent.KEYCODE_2, KeyEvent.KEYCODE_NUMPAD_2 -> 50
            KeyEvent.KEYCODE_3, KeyEvent.KEYCODE_NUMPAD_3 -> 51
            KeyEvent.KEYCODE_4, KeyEvent.KEYCODE_NUMPAD_4 -> 52
            KeyEvent.KEYCODE_5, KeyEvent.KEYCODE_NUMPAD_5 -> 53
            KeyEvent.KEYCODE_6, KeyEvent.KEYCODE_NUMPAD_6 -> 54
            KeyEvent.KEYCODE_7, KeyEvent.KEYCODE_NUMPAD_7 -> 55
            KeyEvent.KEYCODE_8, KeyEvent.KEYCODE_NUMPAD_8 -> 56
            KeyEvent.KEYCODE_9, KeyEvent.KEYCODE_NUMPAD_9 -> 57
            KeyEvent.KEYCODE_CHANNEL_UP, KeyEvent.KEYCODE_PAGE_UP -> 33
            KeyEvent.KEYCODE_CHANNEL_DOWN, KeyEvent.KEYCODE_PAGE_DOWN -> 34
            KeyEvent.KEYCODE_PROG_YELLOW -> 405
            KeyEvent.KEYCODE_PROG_BLUE -> 406
            KeyEvent.KEYCODE_A -> 65
            else -> null
        }
    }

    private fun hideSystemUI() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.insetsController?.let {
                it.hide(WindowInsets.Type.statusBars() or WindowInsets.Type.navigationBars())
                it.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            }
        } else {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility = (
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                    or View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                    or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                    or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                    or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    or View.SYSTEM_UI_FLAG_FULLSCREEN
            )
        }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) {
            hideSystemUI()
        }
    }

    override fun onResume() {
        super.onResume()
        webView.onResume()
        hideSystemUI()
    }

    override fun onPause() {
        super.onPause()
        webView.onPause()
    }

    override fun onDestroy() {
        super.onDestroy()
        webView.destroy()
    }
}
