//Английский словарь OPDS. Ключ - исходная русская строка из кода, значение - перевод
//(строка с {параметрами} или функция от параметров). См. ./i18n.js

function plural(n, one, many) {
    return (Math.abs(Number(n)) === 1 ? one : many);
}

const books = ({n}) => `${n} ${plural(n, 'book', 'books')}`;

const strings = {
    //заголовки разделов
    'Авторы': 'Authors',
    'Серии': 'Series',
    'Книги': 'Books',
    'Книга': 'Book',
    'Жанры': 'Genres',
    'Поиск': 'Search',
    'Моё чтение': 'My reading',
    'Списки чтения': 'Reading lists',
    'Список чтения': 'Reading list',
    'Подборки пользователей': 'User collections',
    'Памятка по поиску': 'Search help',
    'Неизвестная коллекция': 'Unknown collection',

    //навигация
    '[Весь раздел]': '[Whole section]',
    '[Все книги серии]': '[All books in the series]',
    '[Выбрать жанр]': '[Choose genre]',
    '[Другие]': '[Others]',
    '[Остальные авторы]': '[Other authors]',
    '[Остальные названия]': '[Other titles]',
    '[Остальные серии]': '[Other series]',
    '[Следующая страница]': '[Next page]',
    '[Памятка по поиску]': '[Search help]',
    '[Книг пока нет]': '[No books yet]',
    '[Списков пока нет]': '[No lists yet]',
    '[Список пуст]': '[List is empty]',
    '[Выберите профиль пользователя]': '[Choose a user profile]',
    '[Публичных подборок пока нет]': '[No public collections yet]',

    //счетчики
    '{n} книг': books,
    '{n} книг{e}': books,
    '{n} книг{e} по автору': ({n}) => `${books({n})} by the author`,
    '{n} автор{e}': ({n}) => `${n} ${plural(n, 'author', 'authors')}`,
    '{n} сери{e}': ({n}) => `${n} series`,
    '{n} назван{e}': ({n}) => `${n} ${plural(n, 'title', 'titles')}`,
    '{read}/{n} книг{e} прочитано': ({read, n}) => `${read}/${books({n})} read`,
    ' (в выбранном жанре)': ' (in the selected genre)',
    'Списков: {lists}, в чтении: {reading}': 'Lists: {lists}, reading: {reading}',

    //книги
    'Без автора': 'No author',
    'Без названия': 'Untitled',
    ' и др.': ' et al.',
    'Серия: ': 'Series: ',
    'Серия: {name}': 'Series: {name}',
    'Прочитано': 'Read',
    'Не прочитано': 'Unread',
    'Скрыто': 'Hidden',
    'Продолжить чтение': 'Continue reading',
    'Все книги профиля': 'All profile books',
    'Книги, которые сейчас читаются': 'Books currently being read',
    'Книги, отмеченные прочитанными': 'Books marked as read',
    'Книги, скрытые из текущего чтения': 'Books hidden from current reading',
    'Все книги с личным прогрессом профиля': 'All books with personal progress in this profile',
    'Прогресс сохранён, но книга не найдена в текущей библиотеке': 'Progress is saved, but the book was not found in the current library',
    'Добавьте книги в этот список через веб-интерфейс': 'Add books to this list in the web interface',
    'Для OPDS-подборок откройте профиль пользователя': 'Open a user profile for OPDS collections',
    'Создайте список в веб-интерфейсе и переведите его в режим OPDS': 'Create a list in the web interface and switch it to OPDS mode',
    'Включите публикацию списков в профиле и переведите нужные списки в режим OPDS': 'Enable list publishing in the profile and switch the lists you need to OPDS mode',

    //поиск
    'Поиск по каталогу': 'Catalog search',
    'Поиск авторов': 'Search authors',
    'Поиск серий': 'Search series',
    'Поиск книг': 'Search books',
    'Поиск книг в жанре': 'Search books in a genre',
    'Искать по именам авторов': 'Search by author names',
    'Искать по названиям серий': 'Search by series titles',
    'Искать книги по слову в названии, серии и авторе': 'Search books by a word in the title, series or author',
    'Искать по названиям книг в выбранном жанре': 'Search by book titles in the selected genre',
    'Описание формата поискового значения': 'Search value format description',
    'Ошибка: {message}': 'Error: {message}',

    //информация о книге (inpx и fb2)
    'Fb2 инфо': 'Fb2 info',
    'Inpx инфо': 'Inpx info',
    'Информация о файле': 'File information',
    'Папка': 'Folder',
    'Файл': 'File',
    'Размер': 'Size',
    'Добавлен': 'Added',
    'Удален': 'Deleted',
    'Да': 'Yes',
    'Общая информация': 'General information',
    'Автор(ы)': 'Author(s)',
    'Название': 'Title',
    'Серия': 'Series',
    'Жанр': 'Genre',
    'Оценка': 'Rating',
    'Язык книги': 'Book language',
    'Ключевые слова': 'Keywords',
    'Дата': 'Date',
    'Язык оригинала': 'Original language',
    'Переводчик(и)': 'Translator(s)',
    'Информация о произведении на языке оригинала': 'Original language information',
    'Издательская информация': 'Publishing information',
    'Издательство': 'Publisher',
    'Город': 'City',
    'Год': 'Year',
    'Информация о документе (OCR)': 'Document information (OCR)',
    'Программа': 'Program',
    'Версия': 'Version',
    'Автор источника': 'Source author',
    'История': 'History',
    'Правообладатели': 'Copyright holders',
};

//Крупные тексты по идентификатору, см. tText()
const texts = {
    searchHelp: `
Search value format:
<ul>
    <li>
        no prefix: the value means "starts with"
    </li>
    <li>
        prefix "=": exact match
    </li>
    <li>
        prefix "*": substring search
    </li>
    <li>
        prefix "#": substring search, but only among values that do not start with a Latin or Cyrillic character
    </li>
    <li>
        prefix "~": regular expression search
    </li>
    <li>
        prefix "?": search for empty values or values starting with this character
    </li>
</ul>
`,
};

module.exports = {strings, texts};
