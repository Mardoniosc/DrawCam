import basicSsl from '@vitejs/plugin-basic-ssl';

// O app é estático puro — o Vite aqui serve só como servidor de desenvolvimento.
// O plugin de SSL existe porque getUserMedia() exige contexto seguro: no celular,
// http://192.168.x.x NÃO conta como seguro, só https:// (ou localhost).
export default {
  plugins: [basicSsl()],
  server: {
    host: true,   // expõe na rede local para testar no celular
    port: 5173,
  },
};
