<template>
  <Home msg="knvs3" />
</template>

<script lang="ts">
import { defineComponent } from "vue";
import Home from "./components/Home.vue";

export default defineComponent({
  name: "App",
  components: {
    Home,
  },
});
</script>

<style>
#app {
  font-family: Avenir, Helvetica, Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  background-color: black;
  color: white;
}

body {
  margin: 0;
}
</style>
