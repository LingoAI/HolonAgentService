from backend.engine import voice

def test_empty_audio_is_not_an_error():
    text, lang, err = voice.translate_bytes(b"")
    assert text == "" and err is None

def test_lang_names_has_common_languages():
    assert voice.LANG_NAMES["si"] == "Sinhala" and voice.LANG_NAMES["zh"] == "Chinese"
