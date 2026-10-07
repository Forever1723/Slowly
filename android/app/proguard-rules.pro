# Slowly 的 WebView 壳不需要额外混淆规则
-keepclassmembers class com.slowly.app.MainActivity$Bridge {
    public *;
}
