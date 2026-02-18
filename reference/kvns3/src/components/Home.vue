<template>
  <div id="the-game">
    <div id="overlay">
      <img @click="onShotClicked" src="../assets/logo.png" id="shot" class="button" />
      <p>See <code>README.md</code> for more information.</p>

      <button type="button" @click="count++">count is: {{ count }}</button>
      <p>
        Edit
        <code>components/HelloWorld.vue</code> to test hot module replacement.
      </p>
    </div>
  </div>
</template>

<script lang="ts">
import { ref, defineComponent, onMounted, onBeforeUnmount } from "vue";
import Game from "../models/Game";

export default defineComponent({
  name: "Home",
  props: {
    msg: {
      type: String,
      required: true,
    },
  },

  setup(props, context) {
    const count = ref(0);

    // オーバーレイ部品をcanvasに合わせて移動させる
    const fitOverlay = () => {
      const gameEle = document.querySelector("#the-game > canvas");
      if (gameEle) {
        const gameRect = gameEle.getBoundingClientRect();
        const shotEle = document.querySelector<HTMLElement>("#shot");
        if (shotEle) {
          const width = gameRect.width / 7;
          const left = gameRect.right / 2 - width / 2;
          shotEle.style.left = left + "px";
          shotEle.style.top = gameRect.height + "px";
          shotEle.style.width = width + "px";

          const shotRect = shotEle.getBoundingClientRect();
          const top = gameRect.height - shotRect.height;
          shotEle.style.top = top + "px";
        }
      }
    };

    onMounted(async () => {
      console.log("Home onMounted");
      window.addEventListener("resize", fitOverlay);

      const game = new Game();
      game.start(() => {
        fitOverlay();
        console.log("game onStarted");
      });
    });

    onBeforeUnmount(async () => {
      window.removeEventListener("resize", fitOverlay);
    });

    const onShotClicked = () => {
      const gameEle = document.querySelector<HTMLCanvasElement>("#the-game > canvas");
      if (gameEle) {
        // gameEle.toBlob((blob) => {
        //   navigator.msSaveBlob(blob, `screencapture.png`);
        // });
        // window.open(gameEle.toDataURL());
        const a = document.createElement("a");
        a.href = gameEle.toDataURL();
        a.download = "download.png";
        a.click();
      }
    };

    return { count, onShotClicked };
  },
});
</script>

<style scoped>
#the-game {
  width: 100vw;
  height: 100vh;
}

#overlay {
  position: fixed;
  z-index: 9999;
  width: 100vw;
}

#shot {
  position: relative;
  /* left: 10vw;
  bottom: 10vh; */
  /* left: 50px;
  top: 100px; */
}

a {
  color: #42b983;
}

label {
  margin: 0 0.5em;
  font-weight: bold;
}

code {
  background-color: #eee;
  padding: 2px 4px;
  border-radius: 4px;
  color: #304455;
}
</style>
