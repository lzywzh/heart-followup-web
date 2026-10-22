import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
export default defineConfig({base:'/doctor/',plugins:[vue()],server:{proxy:{'/api':'http://127.0.0.1:3200'}},build:{outDir:'dist',chunkSizeWarningLimit:1800}});
