/**
 * What a host that frames this app is allowed to tell it.
 *
 * Three query parameters, read once on mount:
 *
 *   ?embed=1     hide the controls a host already draws — language, theme,
 *                the GitHub link, and settings (which in server mode are the
 *                host's to set anyway). Two sets of those in one window is
 *                how an embed announces itself as a second application.
 *   ?lang=xx     use this locale instead of the visitor's stored one.
 *   ?theme=dark  use this colour mode instead of the visitor's stored one.
 *
 * Query parameters rather than shared storage or postMessage, on purpose:
 * a storage key is a second contract between two applications that must
 * then stay in version step forever, while a parameter is read once and
 * cannot drift. The cost is that a change reloads the frame; the host
 * accepts that for something as infrequent as switching language.
 *
 * Unknown values are ignored, so a host that sends `lang=xx` for a locale
 * this build lacks gets the fallback it would have got anyway.
 */
export function useEmbed() {
  const route = useRoute()
  const { availableLocales, setLocale } = useI18n()
  const colorMode = useColorMode()

  const isEmbedded = computed(() => {
    const value = firstString(route.query.embed)
    return value === '1' || value === 'true'
  })

  onMounted(() => {
    const lang = firstString(route.query.lang)
    if (lang && availableLocales.includes(lang)) {
      setLocale(lang)
    }
    const theme = firstString(route.query.theme)
    if (theme === 'dark' || theme === 'light') {
      colorMode.preference = theme
    }
  })

  return { isEmbedded }
}

function firstString(value: unknown): string | undefined {
  if (Array.isArray(value)) value = value[0]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
