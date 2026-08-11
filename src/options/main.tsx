import React from 'react';
import ReactDOM from 'react-dom/client';
import { SettingsForm } from './SettingsForm';
import './options.scss';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <SettingsForm />
  </React.StrictMode>
);
