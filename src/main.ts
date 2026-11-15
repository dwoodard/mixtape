import { createApp, watch } from "vue";
import App from "./App.vue";
import "./styles.css";
import { applyTheme, themeId } from "./lib/themes";

// Paint the saved theme before the first frame so the wrong colours never flash.
applyTheme(themeId.value, document.documentElement);
watch(themeId, (id) => applyTheme(id, document.documentElement));

createApp(App).mount("#app");
