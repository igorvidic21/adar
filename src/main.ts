import Vue from 'vue'

import './styles/normalize.css'
import './styles/soramitsu-variables.scss'
import '@soramitsu/soramitsu-js-ui/lib/styles'
import App from './App.vue'
import router from './router'
import store from './store'
import i18n from './lang'
import './plugins'

Vue.config.productionTip = false
Vue.config.devtools = process.env.NODE_ENV === 'development'

new Vue({
  i18n,
  router,
  store,
  render: h => h(App)
}).$mount('#app')
