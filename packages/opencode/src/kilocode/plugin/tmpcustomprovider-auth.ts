import type { Plugin } from "@kilocode/plugin"

export const TmpCustomProviderAuthPlugin: Plugin = async () => {
  return {
    auth: {
      provider: "tmpcustomprovider",
      async loader(getAuth) {
        const auth = await getAuth()
        if (!auth) return {}
        if (auth.type !== "api") return {}
        return {
          apiKey: auth.key,
        }
      },
      methods: [
        {
          type: "api",
          label: "API key",
        },
      ],
    },
  }
}

export default TmpCustomProviderAuthPlugin
