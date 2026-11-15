import { createApp, watch } from "vue";
import App from "./App.vue";
import "./styles.css";
import { accentId, applyTheme, themeId } from "./lib/themes";

// Paint the saved theme before the first frame so the wrong colours never flash.
applyTheme(themeId.value, document.documentElement, accentId.value);
watch([themeId, accentId], ([theme, accent]) => applyTheme(theme, document.documentElement, accent));

createApp(App).mount("#app");
