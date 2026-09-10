import * as React from 'react';
import * as ReactDOM from 'react-dom/client';
import { App } from './ReferenceApp';
import '../../style.css';

const rootElement = document.getElementById('root');
if (rootElement) {
    const root = ReactDOM.createRoot(rootElement);
    root.render(<App />);
}
