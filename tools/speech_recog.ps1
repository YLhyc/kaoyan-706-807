Add-Type -AssemblyName System.Speech
try {
    $culture = New-Object System.Globalization.CultureInfo("zh-CN")
    $recognizer = New-Object System.Speech.Recognition.SpeechRecognitionEngine($culture)
    $grammar = New-Object System.Speech.Recognition.DictationGrammar
    $recognizer.LoadGrammar($grammar)
    $recognizer.SetInputToWaveFile("D:\AI_file\706_807专业课背诵手卷\tools\clip_15s.wav")
    $res = $recognizer.Recognize()
    if ($res) {
        Write-Host "Recognized: $($res.Text)"
    } else {
        Write-Host "No speech recognized"
    }
} catch {
    Write-Host "Error: $_"
}
