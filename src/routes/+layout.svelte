<script lang="ts">
  import "../app.css";

  let { children } = $props();
</script>

<div class="root">
  {@render children()}
</div>

<style>
  .root {
    flex: 1 1 auto;
    width: 100%;
    height: 100%;
    max-height: 100%;
    min-height: 0;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
</style>
