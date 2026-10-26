package app.dsh.mobile

import android.app.Activity
import android.content.Context
import android.graphics.Typeface
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.View
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import app.dsh.mobile.engine.EngineConfig
import java.io.File
import java.io.RandomAccessFile
import java.util.concurrent.Executors

/**
 * 日志查看器：把 `engine/engine.log` 与 `engine/boot.log` 的尾部拉到界面里看。
 *
 * 目的：引擎「无限重启」这类问题从外面看不到 logcat，用户也没法导出文件时，
 * 打开本页就能直接看到最后 256KB——正是崩溃原因/重启循环的报错所在。
 *
 * · 每 2 秒自动刷新（离开页面即停）
 * · 只读尾部，避免把 2MB 日志整块读进堆
 * · 文案可长按选择复制（textIsSelectable）
 */
class LogViewerActivity : Activity() {

    companion object {
        private const val TAG = "DSH-log-viewer"
        private const val REFRESH_MS = 2000L
        private const val MAX_TAIL_BYTES = 256 * 1024

        private val FILES = arrayOf("engine.log", "boot.log")
    }

    private val mainHandler = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor { r ->
        Thread(r, "dsh-log-viewer-io").apply { isDaemon = true }
    }

    private var selected = 0
    private var destroyed = false
    private var logText: TextView? = null
    private var sizeText: TextView? = null
    private var fileRow: LinearLayout? = null

    private val autoRefresh = object : Runnable {
        override fun run() {
            if (destroyed) return
            refresh()
            mainHandler.postDelayed(this, REFRESH_MS)
        }
    }

    override fun attachBaseContext(newBase: Context) {
        super.attachBaseContext(LocaleHelper.wrap(newBase))
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        OrientationPrefs.applyTo(this)
        setContentView(R.layout.activity_log_viewer)

        logText = findViewById(R.id.log_viewer_text)
        sizeText = findViewById(R.id.log_viewer_size)
        fileRow = findViewById(R.id.log_viewer_files)

        findViewById<View>(R.id.btnBack).setOnClickListener { finish() }
        findViewById<View>(R.id.log_viewer_refresh).setOnClickListener { refresh() }

        renderFileChips()
        refresh()
    }

    override fun onResume() {
        super.onResume()
        destroyed = false
        mainHandler.removeCallbacks(autoRefresh)
        mainHandler.postDelayed(autoRefresh, REFRESH_MS)
    }

    override fun onPause() {
        destroyed = true
        mainHandler.removeCallbacks(autoRefresh)
        super.onPause()
    }

    override fun onDestroy() {
        destroyed = true
        mainHandler.removeCallbacks(autoRefresh)
        io.shutdownNow()
        super.onDestroy()
    }

    private fun fileAt(index: Int): File {
        val root = EngineConfig.engineRoot(this)
        return File(root, FILES[index.coerceIn(FILES.indices)])
    }

    private fun renderFileChips() {
        val row = fileRow ?: return
        row.removeAllViews()
        for (i in FILES.indices) {
            val name = FILES[i]
            val chip = TextView(this).apply {
                text = name
                gravity = Gravity.CENTER
                isSingleLine = true
                minHeight = dp(40)
                minWidth = dp(104)
                setPadding(dp(14), 0, dp(14), 0)
                textSize = 13f
                typeface = Typeface.MONOSPACE
                setBackgroundResource(if (i == selected) R.drawable.bg_chip_selected else R.drawable.bg_chip)
                setTextColor(if (i == selected) Accent.current(this@LogViewerActivity).argb else 0xFF9AA5B4.toInt())
                setOnClickListener { selectFile(i) }
            }
            val lp = LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT)
            lp.marginEnd = dp(8)
            row.addView(chip, lp)
        }
    }

    private fun selectFile(index: Int) {
        if (index == selected) return
        selected = index
        renderFileChips()
        refresh()
    }

    /** 读尾部 + 刷新界面；在后台线程读，避免 UI 卡顿。 */
    private fun refresh() {
        val idx = selected
        val target = fileAt(idx)
        io.execute {
            val text = readTail(target, MAX_TAIL_BYTES)
            val size = if (target.isFile) target.length() else 0L
            mainHandler.post {
                if (destroyed || selected != idx) return@post
                val tv = logText ?: return@post
                tv.text = if (text.isEmpty()) getString(R.string.log_viewer_empty) else text
                val scroll = tv.parent as? ScrollView
                scroll?.post { scroll.fullScroll(View.FOCUS_DOWN) }
                sizeText?.text = getString(R.string.log_viewer_size, target.absolutePath, size.toString())
            }
        }
    }

    private fun readTail(file: File, maxBytes: Int): String {
        if (!file.isFile) return ""
        val len = file.length()
        if (len == 0L) return ""
        val start = maxOf(0L, len - maxBytes)
        val buf = ByteArray((len - start).toInt())
        RandomAccessFile(file, "r").use { raf ->
            raf.seek(start)
            raf.readFully(buf)
        }
        // 从半截开始读，开头可能切在 UTF-8 多字节中间；容忍个别替换字符。
        return String(buf, Charsets.UTF_8)
    }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()
}
