import { createApp } from './app-shell/createApp';
import './styles/app.css';

const root = document.getElementById('app');
if (!root) {
  throw new Error('Missing #app root element');
}

const router = createApp(root);
router.start();
