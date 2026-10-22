import {defineConfig} from 'vite';
import vue from '@vitejs/plugin-vue';
export default defineConfig({plugins:[vue()],base:'/patient/',server:{host:'127.0.0.1',port:5174,proxy:{'/api':{target:'http://127.0.0.1:3200'}}}});
